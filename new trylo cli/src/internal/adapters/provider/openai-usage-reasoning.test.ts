import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiTranslator } from "./openai-translate.js";

test("Chat usage preserves top-level reasoning tokens without adding them to output", () => {
  const event = createOpenAiTranslator().push({ usage: {
    prompt_tokens: 100, completion_tokens: 80, total_tokens: 180,
    reasoning_tokens: 60, completion_tokens_details: { reasoning_tokens: 60 },
  } })[0];

  assert.equal(event?.type, "usage");

  if (event?.type !== "usage") throw new Error("missing usage");

  assert.equal(event.usage.reasoningTokens, 60);
  assert.equal(event.usage.outputTokens, 80);
  assert.equal(event.usage.totalTokens, 180);
});

test("Chat usage accepts nested reasoning details and preserves explicit zero", () => {
  const translator = createOpenAiTranslator();
  for (const [usage, expected] of [
    [{ completion_tokens_details: { reasoning_tokens: 29 } }, 29],
    [{ reasoning_tokens: 0, completion_tokens_details: { reasoning_tokens: 29 } }, 0],
    [{ reasoning_tokens: "29", completion_tokens_details: { reasoning_tokens: 29 } }, 29],
    [{ reasoning_tokens: -1, completion_tokens_details: { reasoning_tokens: 29 } }, 29],
    [{ reasoning_tokens: Number.NaN, completion_tokens_details: { reasoning_tokens: -2 } }, 0],
    [{ completion_tokens_details: null }, 0],
  ] as const) {
    const event = translator.push({ usage })[0];
    assert.equal(event?.type, "usage");
    if (event?.type !== "usage") throw new Error("missing usage");
    assert.equal(event.usage.reasoningTokens, expected);
  }
});
