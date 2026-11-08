import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider, type OpenAiCompatibleConfig } from "./openai-compatible.js";
import type { ProviderRequest } from "../../ports/provider.js";

const request: ProviderRequest = { attemptId: "old", continuationScope: "old-turn", model: "fixture", messages: [], tools: [] };
const config: OpenAiCompatibleConfig = { endpoint: "https://fixture.invalid/v1/chat/completions", model: "fixture", apiKey: "synthetic-key",
  fetchImpl: async () => { throw new Error("A pure binding must not call transport"); } };

function binding(settings = config, input = request): string | undefined {
  return createOpenAiCompatibleProvider(settings).inputBindingDigest?.(input);
}

test("input binding survives operation addresses and omitted/explicit output allowance", () => {
  assert.match(binding()!, /^[a-f0-9]{64}$/);
  assert.equal(binding(config, { ...request, attemptId: "new", continuationScope: "new-turn", observeReturn: true, maxOutputTokens: 200 }), binding());
});

test("changed origin, effective model, input options and route headers invalidate binding", () => {
  assert.notEqual(binding({ ...config, endpoint: "https://another.invalid/v1/chat/completions" }), binding());
  assert.notEqual(binding(config, { ...request, model: "other-model" }), binding());
  assert.notEqual(binding({ ...config, reasoningEffort: "high" }), binding());
  assert.notEqual(binding({ ...config, headers: { "x-input-route": "other" } }), binding());
  assert.notEqual(binding(config, { ...request, responseFormat: { type: "json_object" } }), binding());
});

test("credentials are excluded while the effective model still follows the real request", () => {
  assert.equal(binding({ ...config, apiKey: "different-synthetic-key", headers: { Authorization: "synthetic-only", "x-api-key": "synthetic-only" } }), binding());
  assert.equal(binding({ ...config, model: "unused-default" }), binding());
  assert.notEqual(binding({ ...config, model: "used-default" }, { ...request, model: "" }), binding(config, { ...request, model: "" }));
});

test("actual chat serialization preserves binding options without an extra preparation or send", async () => {
  const bodies: Record<string, unknown>[] = [];
  const doFetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const frame = { id: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { status: 200 });
  };
  const port = createOpenAiCompatibleProvider({ ...config, reasoningEffort: "high", fetchImpl: doFetch });
  const before = port.inputBindingDigest?.(request);

  assert.equal(bodies.length, 0);

  for await (const _event of port.stream(request, new AbortController().signal)) { /* Consume synthetic transport only. */ }

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.reasoning_effort, "high");
  assert.equal(bodies[0]!.model, request.model);
  assert.equal(port.inputBindingDigest?.({ ...request, continuationScope: "later", maxOutputTokens: 999 }), before);
  assert.notEqual(port.inputBindingDigest?.({ ...request, responseSchema: { type: "object" } }), before);
});
