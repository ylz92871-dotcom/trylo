import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderRequest } from "../../ports/provider.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "../../loop/fakes.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const reasoning = "Synthetic private reasoning for the echo tool round trip.";
const call = { toolCallId: "call-1", name: "echo", arguments: { value: 1 } };
const first = {
  attemptId: "a1", continuationScope: "scope-a", model: "glm-5.3-flash",
  messages: [{ role: "user" as const, content: "Run echo, then report." }], tools: [],
};
const next = {
  ...first, attemptId: "a2", messages: [
    ...first.messages,
    { role: "assistant" as const, content: "Checking.", toolCalls: [call] },
    { role: "tool" as const, content: "ok", toolCallId: call.toolCallId },
  ],
};

type WireMessage = { role: string; reasoning_content?: string };

type WireBody = { messages: WireMessage[] };

function response(text = reasoning, finish = "tool_calls"): Response {
  const frames = [
    { choices: [{ delta: { reasoning_content: text }, finish_reason: null }] },
    { choices: [{ delta: { content: "Checking.", tool_calls: [{ index: 0, id: call.toolCallId,
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
  ];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

function fixture(options: { endpoint?: string; finish?: string; text?: string } = {}) {
  const bodies: WireBody[] = [];
  const provider = createOpenAiCompatibleProvider({
    endpoint: options.endpoint ?? endpoint, model: first.model, apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as WireBody);
      return bodies.length === 1 ? response(options.text, options.finish)
        : new Response('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
    },
  });

  return { provider, bodies, async drain(request: ProviderRequest, signal = new AbortController().signal) {
    for await (const _event of provider.stream(request, signal)) { /* Drain a complete transport round. */ }
  } };
}

const assistant = (body: WireBody) => body.messages.find(message => message.role === "assistant");

test("Volcano GLM sends actual native tool reasoning back on the matching assistant message", async () => {
  const f = fixture();
  await f.drain(first);
  await f.drain(next);
  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, reasoning);
  assert.equal("reasoning_content" in f.bodies[1]!.messages.at(-1)!, false);
});

test("production loop scopes native continuation and replays it across a real adapter tool round trip", async () => {
  const f = fixture();
  const result = await runTurn({ provider: f.provider, permission: createFakePermission("approved"), profile: emptyProfileLoader(),
    tools: { snapshot: () => [echoBinding({ needsApproval: false })], execute: async () => toolResult({ ok: true }), cancel: async () => undefined },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Run echo, then report.", model: first.model, budget: { maxIterations: 4 } });

  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, reasoning);
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.state.verification.status, "unset");
});

test("native continuation never crosses execution scopes", async () => {
  const f = fixture();
  await f.drain(first);
  const otherScope = { ...next, continuationScope: "scope-b" };
  await f.drain(otherScope);
  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, undefined);
});

test("unscoped library calls do not retain native continuation", async () => {
  const f = fixture();
  const { continuationScope: _scope, ...unscoped } = first;
  await f.drain(unscoped);
  await f.drain(next);
  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, undefined);
});

test("other hosts retain the existing no-reasoning-replay behavior", async () => {
  const f = fixture({ endpoint: "https://other.example/v1/chat/completions" });
  await f.drain(first);
  await f.drain(next);
  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, undefined);
});

test("an interrupted or truncated native tool response is never replayed", async () => {
  const f = fixture({ finish: "length" });
  await f.drain(first);
  await f.drain(next);
  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, undefined);
});

test("the same tool identity with changed arguments cannot recover unrelated reasoning", async () => {
  const f = fixture();
  await f.drain(first);
  await f.drain({ ...next, messages: [first.messages[0]!,
    { role: "assistant", content: "Checking.", toolCalls: [{ ...call, arguments: { value: 2 } }] }, next.messages[2]!] });
  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, undefined);
});

test("oversized native reasoning is not partially replayed", async () => {
  const f = fixture({ text: "x".repeat(262145) });
  await f.drain(first);
  await f.drain(next);
  assert.equal(assistant(f.bodies[1]!)?.reasoning_content, undefined);
});
