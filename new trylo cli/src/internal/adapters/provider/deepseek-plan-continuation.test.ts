import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { createGlmToolContinuation } from "./glm-tool-continuation.js";
import { providerContinuationScope, type ProviderMessage, type ProviderOutboundToolCall,
  type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions";
const model = "deepseek-v4.1-flash";
const sessionId = "plan-session";
const scope = (turn: string) => providerContinuationScope(sessionId, turn);
const reasoningA = [" \n原始 A\t", "\u00a0🧭\n "];
const reasoningB = ["\t原始 B\n", "two tools; keep  spaces\r\n"];
const calls: readonly ProviderOutboundToolCall[] = [
  { toolCallId: "plan-call-left", name: "echo", arguments: { side: "left", value: 1 } },
  { toolCallId: "plan-call-right", name: "echo", arguments: { side: "right", value: 2 } },
];

type WireMessage = { role: string; content: string; reasoning_content?: string;
  tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

type WireBody = { model: string; stream: boolean; messages: WireMessage[] };

function response(deltas: readonly Record<string, unknown>[], finish: "stop" | "tool_calls"): Response {
  const frames = [...deltas.map(delta => ({ choices: [{ delta, finish_reason: null }] })),
    { choices: [{ delta: {}, finish_reason: finish }] }];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

async function complete(provider: ProviderPort, request: ProviderRequest): Promise<ProviderMessage> {
  let content = "", finished = 0;
  const toolCalls: ProviderOutboundToolCall[] = [];

  for await (const event of provider.stream(request, new AbortController().signal)) {
    if (event.type === "error") assert.fail(`unexpected in-memory provider error: ${event.class}`);
    if (event.type === "text_delta") content += event.text;
    if (event.type === "tool_call") toolCalls.push({ toolCallId: event.toolCallId, name: event.name, arguments: event.arguments });
    if (event.type === "finish") finished += 1;
  }

  assert.equal(finished, 1);

  return { role: "assistant", content, ...(toolCalls.length === 0 ? {} : { toolCalls }) };
}

function record(checkpoint: JsonObject, turnId: string, sequence: number): SessionRecord {
  return { formatVersion: "1", sequence, type: "envelope", sessionId, turnId, at: "2026-11-05T00:00:00.000Z",
    payload: { envelope: { kind: "stream_end" }, providerContinuation: checkpoint } };
}

function restored(records: readonly SessionRecord[], configuredEndpoint = endpoint, restoredSession = sessionId) {
  const continuation = createGlmToolContinuation(configuredEndpoint, model);
  continuation.persistence?.restore({ sessionId: restoredSession, turnId: "pure", records });
  return continuation;
}

test("Agent Plan DeepSeek keeps exact native assistant reasoning through restore, two tools and a trimmed fork", async () => {
  const bodies: WireBody[] = [];
  const config = { endpoint, model, apiKey: "synthetic-no-network", maxAttemptsBeforeHeaders: 1,
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), endpoint);
      bodies.push(JSON.parse(String(init?.body)) as WireBody);

      if (bodies.length === 1) return response([
        ...reasoningA.map(reasoning_content => ({ reasoning_content })), { content: "First answer." },
      ], "stop");

      if (bodies.length === 2) return response([
        ...reasoningB.map(reasoning_content => ({ reasoning_content })),
        { content: "Checking both.", tool_calls: calls.map((call, index) => ({ index, id: call.toolCallId,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) },
      ], "tool_calls");

      assert.equal(bodies.length, 3, "the contract uses exactly three in-memory provider requests");

      return response([{ content: "Done without native fields." }], "stop");
    } };
  const first = createOpenAiCompatibleProvider(config);
  const base: ProviderRequest = { attemptId: "first", continuationScope: scope("first"), model,
    messages: [{ role: "user", content: "Answer first, then inspect both sides." }],
    tools: [{ name: "echo", description: "Return a side.", parameters: { type: "object" } }] };
  const assistantA = await complete(first, base);
  const savedA = first.continuation?.capture(scope("first"));

  const second = createOpenAiCompatibleProvider(config);

  // Optional only so the unfixed adapter reaches the actual wire regression below.
  second.continuation?.restore({ sessionId, turnId: "second", records: savedA === undefined ? [] : [record(savedA, "first", 1)] });
  const assistantB = await complete(second, { ...base, attemptId: "second", continuationScope: scope("second"),
    messages: [...base.messages, assistantA, { role: "user", content: "Inspect left and right." }] });
  const savedB = second.continuation?.capture(scope("second"));
  const trimmedHistory: ProviderMessage[] = [assistantA, assistantB,
    ...calls.map(call => ({ role: "tool" as const, toolCallId: call.toolCallId, content: `result ${call.toolCallId}` }))];
  const fork = second.fork!(trimmedHistory);
  const finalAssistant = await complete(fork, { ...base, attemptId: "third", continuationScope: scope("third"), messages: trimmedHistory });
  const savedFinal = fork.continuation?.capture(scope("third"));

  assert.equal(bodies.length, 3);
  assert.ok(bodies.every(body => body.model === model && body.stream));
  assert.equal(bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, reasoningA.join(""));
  const assistants = bodies[2]!.messages.filter(message => message.role === "assistant");

  assert.deepEqual(assistants.map(message => message.reasoning_content), [reasoningA.join(""), reasoningB.join("")]);
  assert.equal(assistants[0]!.tool_calls, undefined, "a non-tool assistant stays a non-tool assistant");
  assert.deepEqual(assistants[1]!.tool_calls, calls.map(call => ({ id: call.toolCallId, type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) } })));
  assert.deepEqual(bodies[2]!.messages.map(message => message.role), ["assistant", "assistant", "tool", "tool"]);
  assert.deepEqual(bodies[2]!.messages.filter(message => message.role === "tool").map(message => message.tool_call_id), calls.map(call => call.toolCallId));
  assert.ok(bodies.flatMap(body => body.messages).filter(message => message.role !== "assistant")
    .every(message => !Object.hasOwn(message, "reasoning_content")));
  assert.ok(savedA);
  assert.ok(savedB);
  assert.ok(savedFinal);
  const records = [record(savedA, "first", 1), record(savedB, "second", 2), record(savedFinal, "third", 3)];
  const pureRequest = { ...base, attemptId: "pure", continuationScope: scope("pure"), messages: trimmedHistory };

  // Identity and isolation checks reuse only real captured checkpoints; no more fetches.
  const native = restored(records);
  const changedB: ProviderMessage = { ...assistantB, toolCalls: [calls[0]!, { ...calls[1]!, arguments: { side: "wrong" } }] };
  const changed = native.begin({ ...pureRequest, messages: [assistantA, changedB] });

  assert.equal(changed?.fieldsFor(assistantA).reasoning_content, reasoningA.join(""));
  assert.deepEqual(changed?.fieldsFor(changedB), {}, "same text and tool ids cannot override different call arguments");
  const duplicateA = { ...assistantA };
  const ambiguous = native.begin({ ...pureRequest, messages: [assistantA, duplicateA] });

  assert.deepEqual(ambiguous?.fieldsFor(assistantA), {});
  assert.deepEqual(ambiguous?.fieldsFor(duplicateA), {}, "an incomplete occurrence match never guesses a native origin");
  const keptA = native.begin({ ...pureRequest, messages: [assistantA] });

  assert.equal(keptA?.fieldsFor(assistantA).reasoning_content, reasoningA.join(""), "trimming unrelated history preserves exact matching state");
  const absent = native.begin({ ...pureRequest, messages: [finalAssistant] });

  assert.deepEqual(absent?.fieldsFor(finalAssistant), {}, "a real no-native response never fabricates an empty native field");

  const foreignProvider = restored(records, endpoint + "?connection=other");

  assert.deepEqual(foreignProvider.begin(pureRequest)?.fieldsFor(assistantB) ?? {}, {});
  const foreignSession = restored(records, endpoint, "other-session");

  assert.deepEqual(foreignSession.begin({ ...pureRequest, continuationScope: providerContinuationScope("other-session", "pure") })
    ?.fieldsFor(assistantB) ?? {}, {});
  assert.deepEqual(createGlmToolContinuation(endpoint, model).begin(pureRequest)?.fieldsFor(assistantB) ?? {}, {},
    "another adapter instance cannot obtain reasoning from visible messages alone");
  assert.deepEqual(native.begin({ ...pureRequest, continuationScope: providerContinuationScope("other-session", "next") })
    ?.fieldsFor(assistantB) ?? {}, {}, "changing the active session cannot retain the previous native cache");
});
