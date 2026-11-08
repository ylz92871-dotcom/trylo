import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromptBudgetBasisDecision } from "./prompt-measurement.js";
import { promptBudgetObservationPayload } from "./prompt-budget-observation.js";

const local: PromptBudgetBasisDecision = { basis: "local", tokens: 20, localEstimate: 20,
  reason: "no_report", requestDigest: "a".repeat(64) };

test("the observation preserves selected values and coordinates without inventing optional allowances", () => {
  const before = JSON.stringify(local);
  assert.deepEqual(promptBudgetObservationPayload(local, { streamIndex: 3 }), {
    component: "prompt_budget", status: "selected", basis: "local", tokens: 20, localEstimate: 20,
    reason: "no_report", requestDigest: "a".repeat(64), streamIndex: 3,
  });
  assert.equal(JSON.stringify(local), before);
});

test("server basis provenance and explicit zero are recorded without a local floor or a new bill", () => {
  const decision: PromptBudgetBasisDecision = { basis: "server_plus_added", tokens: 7, localEstimate: 90,
    reason: "complete_prompt_preserved", requestDigest: "b".repeat(64), observedInputTokens: 0, addedTokens: 7,
    inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens: 0 } };
  const payload = promptBudgetObservationPayload(decision,
    { turnId: "turn-fixture", attemptId: "attempt-fixture", streamIndex: 4, contextTokenLimit: 100, explicitOutputAllowance: 0 });

  assert.equal(payload.tokens, 7);
  assert.equal(payload.localEstimate, 90);
  assert.equal(payload.observedInputTokens, 0);
  assert.equal(payload.explicitOutputAllowance, 0);
  assert.equal(payload.turnId, "turn-fixture");
  assert.equal(payload.attemptId, "attempt-fixture");
  assert.deepEqual(payload.inputTokenObservation, { kind: "complete_prompt", source: "provider_complete_input", tokens: 0 });

  for (const field of ["usage", "costUsd", "messages", "tools", "native"]) assert.equal(Object.hasOwn(payload, field), false);
});

test("future decision fields and raw request getters never enter the canonical payload", () => {
  const extended = { ...local, privateRequest: { messages: "PRIVATE_FIXTURE_TEXT" },
    get rawNativeBody(): never { throw new Error("The serializer must not inspect unapproved fields"); } };
  const payload = promptBudgetObservationPayload(extended, { streamIndex: 1 });
  assert.equal(Object.hasOwn(payload, "privateRequest"), false);
  assert.equal(Object.hasOwn(payload, "rawNativeBody"), false);
  assert.equal(JSON.stringify(payload).includes("PRIVATE_FIXTURE_TEXT"), false);
});

test("source provenance is copied by value with only its closed fields", () => {
  const observation = { kind: "complete_prompt" as const, source: "provider_complete_input" as const, tokens: 12,
    rawUsage: "PRIVATE_USAGE_FIXTURE" };
  const decision: PromptBudgetBasisDecision = { ...local, inputTokenObservation: observation, observedInputTokens: 12 };
  const payload = promptBudgetObservationPayload(decision, { streamIndex: 1 });

  observation.tokens = 99;
  assert.deepEqual(payload.inputTokenObservation, { kind: "complete_prompt", source: "provider_complete_input", tokens: 12 });
  assert.equal(JSON.stringify(payload).includes("PRIVATE_USAGE_FIXTURE"), false);
});
