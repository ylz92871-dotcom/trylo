import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { projectForPrompt } from "../../compaction/projection.js";
import { providerContinuationScope, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { testScratchPath } from "../../testing/scratch.js";
import { handleSessionFork } from "./commands-session.js";
import type { CliContext } from "./context.js";
import { sessionPath } from "./session-paths.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const model = "glm-5.3-flash";
const native = " \tSynthetic continuation\nexact UTF-8 🧭 and  spaces\r\n";
const call = { toolCallId: "call", name: "read_file", arguments: { path: "public.txt" } };
const fingerprint = { schemaVersion: "1", providerId: "openai-compatible", model, workspaceId: "w", toolCatalogHash: "h" };
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

type Body = { messages: { role: string; reasoning_content?: string }[] };

function provider(tool: boolean, url = endpoint, name = model) {
  const bodies: Body[] = [];
  const port = createOpenAiCompatibleProvider({ endpoint: url, model: name, apiKey: "synthetic-no-network", fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    const frames = tool ? [
      { choices: [{ delta: { reasoning_content: native, content: "Checking.", tool_calls: [{ index: 0, id: call.toolCallId,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] : [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }];

    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });

  return { port, bodies };
}

async function drain(port: ProviderPort, request: ProviderRequest): Promise<void> {
  for await (const event of port.stream(request, new AbortController().signal)) {
    if (event.type === "error") assert.fail(`synthetic provider error: ${event.class}`);
  }
}

async function captured(): Promise<JsonObject> {
  const first = provider(true);
  const request = { attemptId: "first", model, continuationScope: providerContinuationScope("parent", "first"), tools: [],
    messages: [{ role: "user" as const, content: "Read public.txt." }] };

  await drain(first.port, request);
  const checkpoint = first.port.continuation?.capture(request.continuationScope);

  assert.ok(checkpoint, "the official adapter must produce the complete checkpoint");

  return checkpoint;
}

function context(home: string, output: string[]): CliContext {
  return { homeDir: home, cwd: home, env: { TRYLO_HOME: home }, nodeVersion: "v24", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => output.push(text), stderr: text => assert.fail(text), now: () => 1_000, newId: () => "child" };
}

async function fixture(t: TestContext, checkpoint: JsonObject | undefined, envelopeKind = "stream_end") {
  const home = mkdtempSync(testScratchPath("native-fork-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const output: string[] = [], ctx = context(home, output);
  const parentFile = sessionPath(home, ctx.env, "parent");
  const parent = createNdjsonSessionStore({ path: parentFile });

  assert.equal((await parent.start({ sessionId: "parent", createdAt: "2026-11-08T00:00:00.000Z", fingerprint })).ok, true);
  const payloads: JsonObject[] = [
    { kind: "user", sequence: 0, text: "Read public.txt." },
    { kind: "assistant_text", sequence: 1, blockId: "b", text: "Checking." },
    { kind: "tool_call", sequence: 2, ...call },
    { kind: "tool_result", sequence: 3, toolCallId: call.toolCallId, name: call.name, output: "public evidence", truncated: false, outcome: "succeeded" },
  ];

  for (const payload of payloads) assert.equal((await parent.append({ type: "transcript_item", sessionId: "parent", turnId: "first", at: "2026-11-08T00:00:01.000Z", payload })).ok, true);

  assert.equal((await parent.append({ type: "envelope", sessionId: "parent", turnId: "first", at: "2026-11-08T00:00:02.000Z",
    payload: { envelope: { kind: envelopeKind }, ...(checkpoint === undefined ? {} : { providerContinuation: checkpoint }) } })).ok, true);
  await parent.release();
  const parentHash = sha(readFileSync(parentFile));

  assert.equal(await handleSessionFork(ctx, { session: "parent", newId: "child", interrupted: false, json: true }), 0);
  const child = createNdjsonSessionStore({ path: sessionPath(home, ctx.env, "child") });
  const [source, target, recovered] = await Promise.all([parent.readRecords(), child.readRecords(), child.read()]);

  assert.ok(source.ok && target.ok && recovered.ok);
  assert.equal(sha(readFileSync(parentFile)), parentHash, "fork does not change parent bytes");
  const originalView = projectForPrompt({ records: source.view.records }), childView = projectForPrompt({ records: target.view.records });

  assert.ok(originalView.ok && childView.ok);
  assert.deepEqual(childView.view.items, originalView.view.items);

  return { output: output.join(""), records: target.view.records, source: source.view.records };
}

async function restored(records: readonly SessionRecord[], sessionId = "child", url = endpoint, name = model) {
  const next = provider(false, url, name);

  next.port.continuation?.restore({ sessionId, turnId: "next", records });
  const request: ProviderRequest = { attemptId: "next", model: name, continuationScope: providerContinuationScope(sessionId, "next"), tools: [], messages: [
    { role: "user", content: "Read public.txt." }, { role: "assistant", content: "Checking.", toolCalls: [call] },
    { role: "tool", toolCallId: call.toolCallId, content: "public evidence" },
  ] };
  const identity = next.port.continuation?.measureRequestIdentity?.(request);

  await drain(next.port, request);

  return { native: next.bodies[0]?.messages.find(message => message.role === "assistant")?.reasoning_content,
    overhead: identity?.messageOverheadTokens[1] ?? 0 };
}

test("native session fork rebinds verified format 1/2 checkpoints and preserves exact native bytes", async t => {
  const checkpoint = await captured();
  for (const version of [1, 2]) await t.test(`format ${version}`, async t => {
    const value = version === 1 ? { version: 1, binding: checkpoint.binding!, scope: checkpoint.scope!, assistant: checkpoint.assistant! } : checkpoint;
    const f = await fixture(t, value);
    const actual = await restored(f.records);

    assert.equal(sha(actual.native ?? ""), sha(native));
    assert.equal(actual.overhead, Math.ceil(Buffer.byteLength(native) / 4));
    const stored = f.records.find(record => record.type === "envelope")?.payload.providerContinuation;

    assert.deepEqual(stored, { ...value, scope: providerContinuationScope("child", "first") });
    assert.deepEqual(JSON.parse(f.output).nativeContinuation, { reboundCheckpoints: 1, nativeCheckpoints: 1, unavailable: [] });
    assert.equal((await restored(f.source, "parent")).native, native, "ordinary same-session recovery still works");
    assert.equal((await restored(f.source, "child")).native, undefined, "ordinary foreign-session restore stays isolated");
    assert.equal((await restored(f.records, "child", endpoint + "?account=other")).native, undefined);
    assert.equal((await restored(f.records, "child", endpoint, "glm-5-3-flash")).native, undefined);
  });
});

test("unavailable optional checkpoints keep public fork usable and cannot be laundered into the child", async t => {
  const checkpoint = await captured();
  const cases = [
    { name: "unknown version", value: { ...checkpoint, version: 999 }, kind: "stream_end", cause: "checkpoint_invalid" },
    { name: "foreign source", value: { ...checkpoint, scope: providerContinuationScope("other", "first") }, kind: "stream_end", cause: "binding_mismatch" },
    { name: "destination scope collision", value: { ...checkpoint, scope: providerContinuationScope("child", "first") }, kind: "stream_end", cause: "binding_mismatch" },
    { name: "partial envelope", value: checkpoint, kind: "text_delta", cause: "checkpoint_invalid" },
  ];

  for (const item of cases) await t.test(item.name, async t => {
    const f = await fixture(t, item.value, item.kind);
    assert.equal((await restored(f.records)).native, undefined);
    assert.equal(f.records.find(record => record.type === "envelope")?.payload.providerContinuation, undefined);
    assert.deepEqual(JSON.parse(f.output).nativeContinuation, { reboundCheckpoints: 0, nativeCheckpoints: 0,
      unavailable: [{ cause: item.cause, checkpoints: 1 }] });
  });
});

test("absent and rejected checkpoint metadata is rebound without claiming native material", async t => {
  const checkpoint = await captured();
  for (const state of ["absent", "rejected"]) await t.test(state, async t => {
    const value = { version: 2, binding: checkpoint.binding!, scope: checkpoint.scope!, state,
      identity: { text: "Checking.", calls: [call] }, ...(state === "rejected" ? { cause: "capture_rejected" } : {}) };
    const f = await fixture(t, value);
    assert.equal((await restored(f.records)).native, undefined);
    assert.deepEqual(JSON.parse(f.output).nativeContinuation, { reboundCheckpoints: 1, nativeCheckpoints: 0, unavailable: [] });
  });
});

test("the ordinary no-native fork JSON remains byte-compatible", async t => {
  const f = await fixture(t, undefined);
  assert.equal(f.output, JSON.stringify({ parent: "parent", child: "child", copiedRecords: 5, snapshot: "settled-prefix", droppedPending: 0, droppedPartials: 0 }) + "\n");
});
