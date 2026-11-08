import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiTranslator } from "./openai-translate.js";
import { createAnthropicTranslator } from "./anthropic-translate.js";
import { createResponsesTranslator } from "./responses-translate.js";
import { emptyUsage, mergeUsage } from "../../ports/provider.js";

function observation(value: object): unknown {
  return "inputTokenObservation" in value ? value.inputTokenObservation : undefined;
}

for (const tokens of [123, 0]) test(`explicit raw prompt_tokens ${tokens} carries complete input provenance beside financial usage`, () => {
  const events = createOpenAiTranslator().push({ usage: { prompt_tokens: tokens, completion_tokens: 7, total_tokens: tokens + 7 } });
  const event = events.find(item => item.type === "usage");
  assert.ok(event?.type === "usage");
  assert.deepEqual(observation(event), { kind: "complete_prompt", source: "provider_complete_input", tokens });
  assert.deepEqual(event.usage, { mode: "snapshot", inputTokens: tokens, outputTokens: 7,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: tokens + 7 });
});

for (const tokens of ["123", null, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid raw prompt_tokens ${String(tokens)} cannot claim complete input`, () => {
    const event = createOpenAiTranslator().push({ usage: { prompt_tokens: tokens, completion_tokens: 2, total_tokens: 2 } })
      .find(item => item.type === "usage");
    assert.ok(event?.type === "usage");
    assert.equal(observation(event), undefined);
    // This candidate adds provenance only; existing financial normalization is unchanged.
    assert.equal(event.usage.inputTokens, typeof tokens === "number" ? tokens : 0);
  });
}

test("missing usage and input_tokens alias never synthesize full prompt evidence", () => {
  assert.equal(createOpenAiTranslator().push({}).some(event => event.type === "usage"), false);
  for (const usage of [{}, { input_tokens: 300, completion_tokens: 2, total_tokens: 302 }]) {
    const event = createOpenAiTranslator().push({ usage }).find(item => item.type === "usage");
    assert.ok(event?.type === "usage");
    assert.equal(observation(event), undefined);
  }
});

test("Anthropic and Responses usage retain their existing unqualified semantics", () => {
  const anthropic = createAnthropicTranslator().push("message_start", { message: { usage: { input_tokens: 8 } } });
  const responses = createResponsesTranslator().push("response.completed", { response: {
    status: "completed", usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
  } });

  for (const events of [anthropic, responses]) {
    const event = events.find(item => item.type === "usage");
    assert.ok(event?.type === "usage");
    assert.equal(observation(event), undefined);
    assert.equal(event.usage.inputTokens, 8);
  }
});

test("financial merge and serialized usage keep exactly their old keys and totals", () => {
  const events = createOpenAiTranslator().push({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  const event = events.find(item => item.type === "usage");

  assert.ok(event?.type === "usage");
  const merged = mergeUsage(emptyUsage(), event.usage);

  assert.deepEqual(merged, { mode: "snapshot", inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120 });
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), merged);
  assert.equal("inputTokenObservation" in merged, false);
});
