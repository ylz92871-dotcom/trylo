import assert from "node:assert/strict";
import test from "node:test";
import { decodeToolLearningResult } from "./pipeline.js";

const reasoning = { rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY", expectedBenefit: "TEST ONLY hypothesis", constructionCost: "TEST ONLY", alternatives: [] };
const base = { type: "tool_learning_result", schemaVersion: 1, jobId: `tool-learning_v1_${"a".repeat(64)}`, attempt: 1,
  outcome: "waiting_approval", search: { status: "complete", candidates: [], failures: [] }, occurredAt: "2026-11-04T00:00:00.000Z",
  decisionVersionId: `tool-decision_v1_${"b".repeat(64)}` };

test("cleanup diagnostics preserve npm adaptation and acquisition result contracts without inventing a pure recipe", () => {
  const adaptation = { ...base, code: "npm_candidate_pending_review", candidateVersionId: `tool-production_v1_${"c".repeat(64)}`,
    decision: { ...reasoning, action: "adapt", parentVersionId: `tool-production_v1_${"d".repeat(64)}`, adaptation: "Keep the exact task contract" } };
  const plain = decodeToolLearningResult(adaptation);
  assert.ok(plain);
  const restored = decodeToolLearningResult({ ...adaptation, code: "allowance_release_failed", previousCode: adaptation.code,
    cleanupCode: "worker_retirement_unconfirmed" });
  assert.ok(restored);
  assert.equal(restored.candidateVersionId, plain.candidateVersionId);
  assert.equal(restored.recipeVersionId, undefined);
  assert.equal(restored.cleanupCode, "worker_retirement_unconfirmed");
  assert.ok(decodeToolLearningResult({ ...adaptation, code: "allowance_release_failed", previousCode: adaptation.code }), "legacy wrappers remain readable");
  const acquisition = { ...base, code: "acquisition_approval_required", decision: { ...reasoning, action: "acquire",
    candidate: { platform: "npm", id: "test-only", version: "1.0.0" }, adaptation: "TEST ONLY" } };

  assert.ok(decodeToolLearningResult({ ...acquisition, code: "allowance_release_failed", previousCode: acquisition.code, cleanupCode: "cleanup_unconfirmed" }));
  assert.equal(decodeToolLearningResult({ ...adaptation, cleanupCode: "worker_retirement_unconfirmed" }), undefined);
  assert.equal(decodeToolLearningResult({ ...adaptation, code: "allowance_release_failed", previousCode: adaptation.code, cleanupCode: "PRIVATE_UNTRUSTED_DETAIL" }), undefined);
});
