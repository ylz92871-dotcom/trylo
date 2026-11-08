import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createWorkflowFocusedLearning } from "./focused-learning.js";
import { resultRecord, runtimeFixture, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";

test("PA focused workflow consumes a saved explicitly funded opportunity and later tasks adopt its output", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot, { centralScope: "D:/workflow-workspace" });
  const funded = await fx.ports.funding.fund({ type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: fx.fixture.opportunity, evidence: fx.fixture.evidence });
  assert.ok(funded.ok);
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  const issue = loaded.state.learningIssues![0]!;
  const owner = createWorkflowFocusedLearning(fx.options);
  const result = await owner.focus({ issueId: issue.issueId, expectedRevision: issue.revision,
    reason: "Focus the recorded repeated search waste", sourceRefs: [funded.value.inputVersionId] }, new AbortController().signal);

  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.status, "completed");
  assert.equal(fx.calls(), 1);
  const adopted = resultRecord(await fx.runtime.context("next-task", { task: fx.fixture.opportunity.task, boundary: "before scoped search" }));

  assert.equal(adopted.status, "frozen");
  const resumed = await owner.resume(new AbortController().signal);
  assert.ok(resumed.ok);
  assert.equal(resumed.status, "idle");
  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.centralLearningGrants!.length, 1);
  assert.equal(after.state.centralLearningGrants![0]!.status, "closed");
  await fx.runtime.close();
}));
