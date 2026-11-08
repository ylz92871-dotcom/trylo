import assert from "node:assert/strict";
import test from "node:test";
import type { ToolLearningPlan } from "./pipeline.js";
import { toolLearningFundingClaimBelongsTo, toolLearningFundingClaimId, toolLearningFundingClaimMatches } from "./funding-identity.js";

const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "funding-identity-test", capability: "test identity",
  createdAt: "2026-11-04T00:00:00.000Z", trigger: { runId: "test", proposalKey: "test", action: "user_requested", evidenceRefs: [] } };

test("legacy history remains readable while current epoch ownership requires its actual central step", () => {
  const legacy = toolLearningFundingClaimId(plan, "parent", 1), second = toolLearningFundingClaimId(plan, "parent", 1, 2);

  assert.notEqual(legacy, second);
  assert.ok(toolLearningFundingClaimMatches(plan, "parent", 1, { claimId: legacy, step: 2 }));
  assert.ok(toolLearningFundingClaimMatches(plan, "parent", 1, { claimId: second, step: 2 }));
  assert.equal(toolLearningFundingClaimMatches(plan, "parent", 1, { claimId: second, step: 3 }), false);
  assert.ok(toolLearningFundingClaimBelongsTo(plan, "parent", 1, second), "history has no live step but retains its parent provenance");
  assert.equal(toolLearningFundingClaimBelongsTo(plan, "other-parent", 1, second), false);
  assert.equal(toolLearningFundingClaimBelongsTo(plan, "parent", 2, second), false);
  assert.equal(toolLearningFundingClaimBelongsTo(plan, "parent", 1, `${legacy}:lease:02`), false);
  assert.equal(toolLearningFundingClaimBelongsTo(plan, "parent", 1, `${legacy}:lease:9007199254740992`), false);
});
