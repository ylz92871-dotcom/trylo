import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { parseWorkflowOpportunity } from "./parse.js";
import { buildWorkflowImprovement } from "./build.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { runtimeFixture, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";

test("a grounded central research purpose is prospective and creates only an untested proposal", () => {
  const fixture = searchImprovementFixture();
  const opportunity = parseWorkflowOpportunity({ ...fixture.opportunity, trigger: "central_research" });

  assert.ok(opportunity.ok, JSON.stringify(opportunity));
  const candidate = buildWorkflowImprovement({ opportunity: opportunity.value, evidence: fixture.evidence,
    proposal: fixture.proposal, history: [] });

  assert.ok(candidate.ok, JSON.stringify(candidate));
  assert.equal(candidate.value.opportunity.trigger, "central_research");
  assert.equal(candidate.value.claim, "proposed_improvement");
  assert.equal(Object.hasOwn(candidate.value, "qualityPassed"), false);
});

test("a normal business nomination cannot claim the native central-research trigger", async () => withImprovementBoard(async boardRoot => {
  const fixture = runtimeFixture(boardRoot);
  try {
    const result = await fixture.runtime.opportunity("business-claims-central", { ...fixture.fixture.opportunity, trigger: "central_research" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "workflow_central_research_requires_native_receiver");
    assert.equal(fixture.calls(), 0);
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    assert.equal(board.state.centralLearningGrants?.length ?? 0, 0);
  } finally { await fixture.runtime.close(); }
}));
