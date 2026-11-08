import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createModelSummarizer, SUMMARIZER_INSTRUCTION } from "../surface/cli/compact-model-summarizer.js";

type WireMessage = { role: string; content: string; tool_call_id?: string;
  tool_calls?: Array<{ id: string }> };

type WireBody = { messages: WireMessage[]; tools?: unknown[] };

const PARTIAL = "This incomplete model summary must never become a stored window.";

function response(frames: ReadonlyArray<unknown>): Response {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
}

test("a partial Chat summary error stores only extractive facts and the next wire keeps tool pairing", async () => {
  const wires: WireBody[] = [];
  let mainRequests = 0;
  const provider = createOpenAiCompatibleProvider({ endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture", apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as WireBody;

      wires.push(body);

      if (body.messages.some(message => message.content.startsWith(SUMMARIZER_INSTRUCTION))) {
        return response([
          { choices: [{ delta: { content: PARTIAL }, finish_reason: null }] },
          { error: { type: "server_error", message: "fixture summary interruption" } },
        ]);
      }

      if (++mainRequests === 1) return response([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "read-proof", function: { name: "echo", arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9500, completion_tokens: 10, total_tokens: 9510 } },
      ]);

      return response([{ choices: [{ delta: { content: "Verified the actual fixture." }, finish_reason: "stop" }] }]);
    } });
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "verified fixture value")], [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, summarize: createModelSummarizer({ provider, model: "fixture" }) }),
  }, { sessionId: "s", turnId: "t", correlationId: "c", model: "fixture", text: "Read the fixture and verify its actual value.",
    budget: { maxIterations: 3, contextTokenLimit: 10_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 1);
  assert.equal(result.compactions[0]!.payload.summary.includes(PARTIAL), false);
  assert.match(result.compactions[0]!.payload.summary, /Read the fixture/);
  const next = wires.at(-1)!;

  assert.equal(next.messages.some(message => message.content.includes(PARTIAL)), false);
  assert.ok(next.messages.some(message => message.content.includes("[compacted history")));
  const calls = next.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []);
  const results = next.messages.filter(message => message.role === "tool").map(message => message.tool_call_id);

  assert.deepEqual(calls, ["read-proof"]);
  assert.deepEqual(results, calls);
  assert.equal(next.messages.find(message => message.role === "tool")?.content, "verified fixture value");
});

test("cancelling summary authoring never creates a compaction draft", async () => {
  const cancel = new AbortController();
  const provider = createOpenAiCompatibleProvider({ endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture", apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as WireBody;
      if (body.messages.some(message => message.content.startsWith(SUMMARIZER_INSTRUCTION))) {
        cancel.abort();
        return response([{ choices: [{ delta: { content: PARTIAL }, finish_reason: "stop" }] }]);
      }

      return response([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "read-proof", function: { name: "echo", arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9500, completion_tokens: 10, total_tokens: 9510 } },
      ]);
    } });
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "verified fixture value")], [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, summarize: createModelSummarizer({ provider, model: "fixture" }) }),
  }, { sessionId: "s", turnId: "t", correlationId: "c", model: "fixture", text: "Read the fixture.",
    budget: { maxIterations: 3, contextTokenLimit: 10_000 }, cancelSignal: cancel.signal });

  assert.equal(result.compactions.length, 0);
  assert.equal(result.state.terminalReason, "cancelled");
});

test("cancelling a summary with no terminal frame interrupts the HTTP read and stores no window", async () => {
  const cancel = new AbortController();
  let summaryAborted = false;
  let summaryBody: ReadableStream<Uint8Array> | undefined;
  const provider = createOpenAiCompatibleProvider({ endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture", apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as WireBody;
      if (body.messages.some(message => message.content.startsWith(SUMMARIZER_INSTRUCTION))) {
        summaryBody = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: PARTIAL }, finish_reason: null }] })}\n\n`));
          init?.signal?.addEventListener("abort", () => {
            summaryAborted = true;
            controller.error(new Error("fixture aborted HTTP body"));
          }, { once: true });
          setImmediate(() => {
            cancel.abort();
            // Release the baseline's un-aborted read as well, so red proof never hangs.
            setImmediate(() => { if (!summaryAborted) controller.close(); });
          });
        } });
        return new Response(summaryBody);
      }

      return response([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "read-proof", function: { name: "echo", arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9500, completion_tokens: 10, total_tokens: 9510 } },
      ]);
    } });
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "verified fixture value")], [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, summarize: createModelSummarizer({ provider, model: "fixture" }) }),
  }, { sessionId: "s", turnId: "t", correlationId: "c", model: "fixture", text: "Read the fixture.",
    budget: { maxIterations: 3, contextTokenLimit: 10_000 }, cancelSignal: cancel.signal });

  assert.equal(summaryAborted, true);
  assert.equal(summaryBody?.locked, false);
  assert.equal(result.compactions.length, 0);
  assert.equal(result.state.terminalReason, "cancelled");
});
