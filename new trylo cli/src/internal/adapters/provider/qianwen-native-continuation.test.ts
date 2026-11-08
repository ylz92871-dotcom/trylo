import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { providerContinuationScope, type ProviderMessage, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";

const endpoint = "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions";
const model = "qwen3.8-flash", sessionId = "qianwen-native-contract";
const nativeParts = [" \t原始续接\n", "keep  both spaces 🧭\r\n"];

type Body = { model: string; preserve_thinking?: boolean; reasoning_effort?: string;
  max_tokens?: number; thinking_budget?: number; enable_thinking?: boolean;
  messages: { role: string; content: string; reasoning_content?: string }[] };

function response(tool: boolean): Response {
  const deltas = tool ? [
    ...nativeParts.map(reasoning_content => ({ reasoning_content })),
    { tool_calls: [{ index: 0, id: "qianwen-read", function: { name: "read_file", arguments: '{"path":"source.txt"}' } }] },
  ] : [{ content: "Done." }];
  const frames = [...deltas.map(delta => ({ choices: [{ delta, finish_reason: null }] })),
    { choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] }];

  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

async function complete(provider: ProviderPort, request: ProviderRequest): Promise<ProviderMessage> {
  let content = "", finishes = 0;
  const calls: { toolCallId: string; name: string; arguments: JsonObject }[] = [];

  for await (const event of provider.stream(request, new AbortController().signal)) {
    if (event.type === "error") assert.fail(`in-memory provider error: ${event.class}`);
    if (event.type === "text_delta") content += event.text;
    if (event.type === "tool_call") calls.push({ toolCallId: event.toolCallId, name: event.name, arguments: event.arguments });
    if (event.type === "finish") finishes++;
  }

  assert.equal(finishes, 1);

  return { role: "assistant", content, ...(calls.length === 0 ? {} : { toolCalls: calls }) };
}

function checkpointRecord(checkpoint: JsonObject): SessionRecord {
  return { formatVersion: "1", sequence: 1, type: "envelope", sessionId, turnId: "first", at: "2026-11-08T00:00:00.000Z",
    payload: { envelope: { kind: "stream_end" }, providerContinuation: checkpoint } };
}

test("the exact Qianwen Flash profile restores native tool continuation and measures its full bytes", async () => {
  const bodies: Body[] = [];
  const config = { endpoint, model, apiKey: "synthetic-no-network", fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return response(bodies.length === 1);
  } };
  const first = createOpenAiCompatibleProvider(config);
  const base: ProviderRequest = { attemptId: "first", model, continuationScope: providerContinuationScope(sessionId, "first"),
    messages: [{ role: "user", content: "Inspect source.txt and finish." }],
    tools: [{ name: "read_file", description: "Read a source", parameters: { type: "object" } }] };
  const assistant = await complete(first, base), saved = first.continuation?.capture(base.continuationScope!);
  const next: ProviderRequest = { ...base, attemptId: "second", continuationScope: providerContinuationScope(sessionId, "second"),
    messages: [...base.messages, assistant, { role: "tool", toolCallId: "qianwen-read", content: "Observed source." }] };
  const second = createOpenAiCompatibleProvider(config);

  second.continuation?.restore({ sessionId, turnId: "second", records: saved === undefined ? [] : [checkpointRecord(saved)] });
  const measurement = second.continuation?.measureRequestIdentity?.(next);

  await complete(second, next);

  assert.equal(bodies[1]!.messages.find(message => message.role === "assistant")?.reasoning_content, nativeParts.join(""));
  assert.ok(saved, "only the adapter's completed response can supply a persisted native checkpoint");
  assert.ok(bodies.every(body => body.preserve_thinking === true), "explicit documented preservation avoids inconsistent service defaults");
  assert.ok(measurement);
  assert.equal(measurement.messageOverheadTokens[1], Buffer.byteLength(nativeParts.join(""), "utf8"));
  assert.ok(bodies.every(body => !Object.hasOwn(body, "max_tokens") && !Object.hasOwn(body, "thinking_budget")));
  assert.ok(bodies.every(body => !Object.hasOwn(body, "reasoning_effort") && !Object.hasOwn(body, "enable_thinking")),
    "continuation must not replace the caller's reasoning choice or the provider's default effort");
  assert.ok(bodies.flatMap(body => body.messages).filter(message => message.role !== "assistant")
    .every(message => !Object.hasOwn(message, "reasoning_content")));
  const fork = second.fork!(next.messages);

  assert.deepEqual(fork.continuation?.measureRequestIdentity?.({ ...next, continuationScope: providerContinuationScope(sessionId, "fork") })
    ?.messageOverheadTokens, measurement.messageOverheadTokens, "a native trimmed fork uses the existing adapter-owned inherited cache");

  const foreign = createOpenAiCompatibleProvider(config);

  foreign.continuation?.restore({ sessionId: "foreign", turnId: "second", records: saved === undefined ? [] : [checkpointRecord(saved)] });
  assert.equal(foreign.continuation?.measureRequestIdentity?.({ ...next, continuationScope: providerContinuationScope("foreign", "second") })
    ?.messageOverheadTokens[1], 0, "another session cannot use the original session's checkpoint");
});

test("Qianwen native preservation is confined to the exact service and model", async () => {
  const profiles = [
    { endpoint: endpoint + "?connection=other", model },
    { endpoint: endpoint.replace("maas.qianwenaiapi.com", "other.example"), model },
    { endpoint, model: "qwen3.8-flash-next" },
    { endpoint, model: "qwen3.8-max" },
  ];
  for (const profile of profiles) {
    let body: Body | undefined;
    const provider = createOpenAiCompatibleProvider({ ...profile, reasoningEffort: "medium", apiKey: "synthetic-no-network",
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Body;
        return response(false);
      } });

    await complete(provider, { attemptId: "negative", model: profile.model, continuationScope: providerContinuationScope(sessionId, "negative"),
      messages: [{ role: "user", content: "Hello" }], tools: [] });
    assert.ok(body);
    assert.equal(Object.hasOwn(body, "preserve_thinking"), false);
    assert.equal(body.reasoning_effort, "medium");
    assert.equal(provider.continuation, undefined);
  }
});
