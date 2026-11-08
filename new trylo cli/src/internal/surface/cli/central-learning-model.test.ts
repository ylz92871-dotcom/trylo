import assert from "node:assert/strict";
import test from "node:test";
import { centralLearningGenerationRef } from "./central-learning-model.js";

const model = { providerId: "test-provider", providerKind: "openai-compatible" as const, model: "test-model",
  endpoint: "https://generation.example/v1", reasoningEffort: "medium" as const };
const envelope = { maxOutputTokens: 8192, thoughtMaxTokens: 64000, maxPromptChars: 100000 };

test("generation identity changes for actual model, reasoning effort or output limit and retains no endpoint text", () => {
  const original = centralLearningGenerationRef(model, envelope);

  for (const changed of [{ ...model, model: "another-model" }, { ...model, reasoningEffort: "high" as const },
    { ...model, endpoint: "https://another-generation.example/v1" }]) {
    assert.notEqual(centralLearningGenerationRef(changed, envelope), original);
  }

  assert.notEqual(centralLearningGenerationRef(model, { ...envelope, maxOutputTokens: 16384 }), original);
  assert.match(original, /^central-learning-generation:[a-f0-9]{64}$/);
  assert.equal(original.includes(model.endpoint), false);
});

test("root credit, unused prompt or thought ceilings and display settings cannot impersonate changed generation", () => {
  const original = centralLearningGenerationRef(model, envelope);
  const hostOnly = { ...model, reasoningSummary: "auto" as const, accountId: "another-account", userLearning: true, rootRef: "root:another",
    available: { tokens: 999999, calls: 99, steps: 99 }, allowance: { calls: 99, steps: 99 } };
  const schedulingOnly = { ...envelope, thoughtMaxTokens: 65000, maxPromptChars: 999999, calls: 99, steps: 99, rootTokens: 999999 };
  assert.equal(centralLearningGenerationRef(hostOnly, schedulingOnly), original);
  assert.equal(centralLearningGenerationRef({ ...model }, { ...envelope }), original);
});
