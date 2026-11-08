import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderRequest } from "../../ports/provider.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const model = "glm-5.3-flash", reasoning = "Synthetic persisted native continuation.";
const scope = (turn: string) => JSON.stringify(["session-a", turn]);
const call = { toolCallId: "call-a", name: "echo", arguments: { value: 1 } };
const request: ProviderRequest = { attemptId: "a", model, continuationScope: scope("first"), tools: [],
  messages: [{ role: "user", content: "Check." }] };
const resumed: ProviderRequest = { ...request, continuationScope: scope("second"), messages: [
  ...request.messages, { role: "assistant", content: "Checking.", toolCalls: [call] },
  { role: "tool", toolCallId: call.toolCallId, content: "ok" },
] };

function fixture(finish = "tool_calls", configuredEndpoint = endpoint, configuredModel = model) {
  const bodies: Array<{ messages: Array<{ role: string; reasoning_content?: string }> }> = [];
  const provider = createOpenAiCompatibleProvider({ endpoint: configuredEndpoint, model: configuredModel, apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const frames = [{ choices: [{ delta: { reasoning_content: reasoning, content: "Checking.", tool_calls: [
        { index: 0, id: call.toolCallId, function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
      ] }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: finish }] }];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    } });

  return { provider, bodies, async drain(input: ProviderRequest) {
    for await (const _event of provider.stream(input, new AbortController().signal)) { /* Complete transport consumption. */ }
  } };
}

function record(checkpoint: JsonObject): SessionRecord {
  return { formatVersion: "1", sequence: 1, type: "envelope", sessionId: "session-a", turnId: "first",
    at: "2026-10-15T00:00:00.000Z", payload: { envelope: { kind: "stream_end" }, providerContinuation: checkpoint } };
}

async function checkpoint() {
  const f = fixture();
  await f.drain(request);
  const value = f.provider.continuation?.capture(scope("first"));
  assert.ok(value, "a complete native tool response must expose a durable checkpoint");
  assert.equal(f.provider.continuation?.capture(scope("other")), undefined);
  return value;
}

test("a fresh provider restores native reasoning only through explicit verified session records", async () => {
  const value = await checkpoint(), f = fixture();
  f.provider.continuation!.restore({ sessionId: "session-a", turnId: "second", records: [record(value)] });
  await f.drain(resumed);
  assert.equal(f.bodies[0]!.messages.find(message => message.role === "assistant")?.reasoning_content, reasoning);
  assert.equal(f.bodies[0]!.messages.at(-1)!.reasoning_content, undefined);
});

test("restored state still requires the exact assistant text and complete tool call arguments", async () => {
  const value = await checkpoint(), f = fixture();
  f.provider.continuation!.restore({ sessionId: "session-a", turnId: "second", records: [record(value)] });
  await f.drain({ ...resumed, messages: [request.messages[0]!,
    { role: "assistant", content: "Checking.", toolCalls: [{ ...call, arguments: { value: 2 } }] }, resumed.messages[2]!] });
  assert.equal(f.bodies[0]!.messages.find(message => message.role === "assistant")?.reasoning_content, undefined);
});

test("native recovery rejects foreign, partial, malformed and unsupported checkpoints", async t => {
  const value = await checkpoint();
  const cases: Array<[string, (value: JsonObject) => SessionRecord]> = [
    ["foreign session", value => ({ ...record(value), sessionId: "other" })],
    ["foreign turn", value => ({ ...record(value), turnId: "other" })],
    ["old version", value => record({ ...value, version: 0 })],
    ["unknown fields", value => record({ ...value, unexpected: true })],
    ["partial envelope", value => ({ ...record(value), payload: { envelope: { kind: "text_delta" }, providerContinuation: value } })],
    ["empty reasoning", value => record({ ...value, assistant: { reasoning: "", text: "Checking.", calls: [call] } })],
    ["invalid arguments", value => record({ ...value, assistant: { reasoning, text: "Checking.", calls: [{ ...call, arguments: [] }] } })],
    ["duplicate calls", value => record({ ...value, assistant: { reasoning, text: "Checking.", calls: [call, call] } })],
    ["oversized reasoning", value => record({ ...value, assistant: { reasoning: "x".repeat(262145), text: "Checking.", calls: [call] } })],
  ];

  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture();
    f.provider.continuation!.restore({ sessionId: "session-a", turnId: "second", records: [mutate(value)] });
    await f.drain(resumed);
    assert.equal(f.bodies[0]!.messages.find(message => message.role === "assistant")?.reasoning_content, undefined);
  });
});

test("model binding and complete endpoint binding prevent foreign native replay", async () => {
  const value = await checkpoint();

  for (const [url, name] of [[endpoint + "?account=other", model], [endpoint, "glm-5-3-flash"]]) {
    const f = fixture("tool_calls", url, name);
    f.provider.continuation!.restore({ sessionId: "session-a", turnId: "second", records: [record(value)] });
    await f.drain({ ...resumed, model: name! });
    assert.equal(f.bodies[0]!.messages.find(message => message.role === "assistant")?.reasoning_content, undefined);
  }

  assert.equal(fixture("tool_calls", "https://other.example/v1/chat/completions").provider.continuation, undefined);
});

test("truncated responses have no checkpoint, and a new request erases a stale completed checkpoint", async () => {
  const truncated = fixture("length");

  await truncated.drain(request);
  assert.equal(truncated.provider.continuation?.capture(scope("first")), undefined);
  const f = fixture();

  await f.drain(request);
  assert.ok(f.provider.continuation?.capture(scope("first")));
  const iterator = f.provider.stream({ ...request, attemptId: "next" }, new AbortController().signal)[Symbol.asyncIterator]();

  await iterator.next();
  assert.equal(f.provider.continuation?.capture(scope("first")), undefined);
  await iterator.return?.();
});
