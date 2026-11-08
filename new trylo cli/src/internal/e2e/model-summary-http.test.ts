import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { createModelSummarizer } from "../surface/cli/compact-model-summarizer.js";
import { summarizeTranscript } from "../compaction/summary.js";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { translateBody } from "../adapters/provider/openai-stream.js";

const items: TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Verify the source before reporting." }];
const text = "A complete safe summary.";
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const content = frame({ choices: [{ delta: { content: text }, finish_reason: null }] });
const stop = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
const usage = frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function endpoint(t: TestContext, handler: (response: ServerResponse, body: Record<string, unknown>) => Promise<void> | void) {
  const closed = deferred();
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    response.once("close", closed.resolve);
    response.writeHead(200, { "content-type": "text/event-stream" });
    await handler(response, JSON.parse(raw) as Record<string, unknown>);
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = createOpenAiCompatibleProvider({ endpoint: `http://127.0.0.1:${address.port}`, model: "fixture", apiKey: "fixture-key", maxAttemptsBeforeHeaders: 1 });
  const seen: ProviderEvent[] = [], visible = deferred();
  const observed: ProviderPort = { async *stream(request, signal) {
    for await (const event of provider.stream(request, signal)) {
      seen.push(event);
      if (event.type === "text_delta") visible.resolve();
      yield event;
    }
  } };

  return { provider: observed, seen, visible: visible.promise, closed: closed.promise };
}

test("actual HTTP summary waits for delayed usage after stop and releases the reader at DONE", { timeout: 5000 }, async t => {
  const trailing = deferred();
  const fx = await endpoint(t, async response => {
    response.write(content + stop);
    await trailing.promise;
    response.write(usage + "data: [DONE]\n\n");
    // Deliberately keep HTTP open; the protocol terminator must release it.
  });
  let settled = false;
  const result = createModelSummarizer({ provider: fx.provider, model: "fixture" })(items).then(value => {
    settled = true;
    return value;
  });

  await fx.visible;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, "wire stop alone is held for trailing usage");
  trailing.resolve();
  assert.equal(await result, text);
  const measured = fx.seen.find(event => event.type === "usage");

  assert.equal(measured?.type === "usage" ? measured.usage.totalTokens : undefined, 15);
  await fx.closed;
});

for (const hasStop of [false, true]) {
  test(`actual HTTP ${hasStop ? "stop without DONE" : "text without finish"} remains cancellable and never publishes on cancel`, { timeout: 5000 }, async t => {
    const fx = await endpoint(t, response => { response.write(content + (hasStop ? stop : "")); });
    const cancel = new AbortController();
    const result = createModelSummarizer({ provider: fx.provider, model: "fixture" })(items, undefined, cancel.signal);
    await fx.visible;
    cancel.abort();
    assert.equal(await result, summarizeTranscript(items));
    await fx.closed;
  });
}

test("actual HTTP EOF with a half JSON frame discards partial authoring", { timeout: 5000 }, async t => {
  const fx = await endpoint(t, response => { response.end(content + 'data: {"choices":['); });
  assert.equal(await createModelSummarizer({ provider: fx.provider, model: "fixture" })(items), summarizeTranscript(items));
  await fx.closed;
});

test("actual HTTP disconnect after visible text falls back without retrying the response body", { timeout: 5000 }, async t => {
  let connection!: ServerResponse;
  let requests = 0;
  const fx = await endpoint(t, response => {
    requests++;
    connection = response;
    response.write(content);
  });
  const result = createModelSummarizer({ provider: fx.provider, model: "fixture" })(items);

  await fx.visible;
  connection.destroy();
  assert.equal(await result, summarizeTranscript(items));
  assert.equal(requests, 1);
  assert.ok(fx.seen.some(event => event.type === "error" && event.class === "network"));
  await fx.closed;
});

test("actual HTTP stop plus usage and EOF succeeds even without a DONE frame", { timeout: 5000 }, async t => {
  const fx = await endpoint(t, response => { response.end(content + stop + usage); });
  assert.equal(await createModelSummarizer({ provider: fx.provider, model: "fixture" })(items), text);
  assert.ok(fx.seen.some(event => event.type === "usage"));
  await fx.closed;
});

test("cancellation cleanup still propagates an unrelated reader failure and releases its lock", async () => {
  const failure = new Error("fixture unexpected cleanup failure");
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(content)); },
    cancel() { throw failure; },
  });
  const cancel = new AbortController(), stream = translateBody(source, cancel.signal);

  assert.equal((await stream.next()).value?.type, "text_start");
  assert.equal((await stream.next()).value?.type, "text_delta");
  cancel.abort();
  await assert.rejects(stream.return(undefined), error => error === failure);
  assert.equal(source.locked, false);
});

test("model summary usage shares parent spending while main iterations remain separate", { timeout: 5000 }, async t => {
  const requests: Record<string, unknown>[] = [];
  const fx = await endpoint(t, (response, body) => {
    requests.push(body);
    const messages = body.messages as Array<{ content: string }>;
    if (messages.some(message => message.content.startsWith("You are the trylo compaction summarizer."))) {
      response.end(content + stop + usage + "data: [DONE]\n\n");
      return;
    }

    const first = requests.length === 1;
    const delta = first ? { tool_calls: [{ index: 0, id: "echo", function: { name: "echo", arguments: "{}" } }] } : { content: "Verified." };

    response.end(frame({ choices: [{ delta, finish_reason: first ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: first ? 7200 : 100, completion_tokens: 5, total_tokens: first ? 7205 : 105 } }) + "data: [DONE]\n\n");
  });
  const result = await runTurn({ provider: fx.provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "observed value")], [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, summarize: createModelSummarizer({ provider: fx.provider, model: "fixture" }) }),
  }, { sessionId: "s", turnId: "t", correlationId: "c", model: "fixture", text: "Verify.", budget: { maxIterations: 2, maxOutputTokens: 50, contextTokenLimit: 7500 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests.length, 3);
  assert.equal(result.iterations, 2);
  assert.deepEqual(requests.map(request => request.max_tokens), [50, 45, 42]);
  assert.equal(result.usage.outputTokens, 13);
  assert.equal(result.usage.inputTokens, 7312);
  assert.equal(result.mainUsage?.inputTokens, 7300);
  assert.equal(result.mainUsage?.outputTokens, 10);
  assert.equal(result.auxiliaryUsage?.inputTokens, 12);
  assert.equal(result.auxiliaryUsage?.outputTokens, 3);
  assert.equal(result.auxiliaryRequests?.length, 1);
});
