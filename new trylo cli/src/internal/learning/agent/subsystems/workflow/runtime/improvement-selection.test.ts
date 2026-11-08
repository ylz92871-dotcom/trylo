import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowImprovement } from "../improvement/index.js";
import type { WorkflowImprovement, WorkflowImprovementFeedback } from "../improvement/contracts.js";
import type { WorkflowImprovementBoardView } from "./improvement-contracts.js";
import { selectWorkflowImprovement } from "./improvement-selection.js";
import { searchImprovementFixture, improvementFeedbackFixture } from "../testing/improvement-fixtures.js";

function pair() {
  const fixture = searchImprovementFixture(), built = buildWorkflowImprovement(fixture);
  assert.ok(built.ok);
  const parent = built.value, action = "Inspect current generation status, then confirm the owner before reusing the location.";
  const next = buildWorkflowImprovement({ ...fixture, parent, parentVersionId: "version:parent",
    opportunity: { ...fixture.opportunity, opportunityId: "opportunity:child" },
    proposal: { ...fixture.proposal, procedure: { ...fixture.proposal.procedure,
      steps: fixture.proposal.procedure.steps.map((step, index) => index === 0 ? { ...step, action } : step) },
      changes: [{ ...fixture.proposal.changes[0]!, kind: "replace", stepIds: ["confirm-owner"],
        before: parent.proposal.procedure.steps[0]!.action, after: action }] } });
  assert.ok(next.ok);
  const view: WorkflowImprovementBoardView = { versions: [
    { versionId: "version:parent", artifact: parent, status: "eligible" },
    { versionId: "version:child", artifact: next.value, status: "eligible" },
  ], opportunities: [], uses: [], feedback: [], recentIssues: [] };

  return { fixture, parent, child: next.value, view };
}

function judgment(versionId: string, kind: "helped" | "harmed", execution: string): WorkflowImprovementFeedback {
  return improvementFeedbackFixture({ feedbackId: `feedback:${execution}`, useId: `use:${execution}`, versionId, executionId: execution,
    quality: "unknown", evidenceRefs: [], processEvidence: { kind: "unverified" }, userAssessment: { judgment: kind, evidenceRef: `user:${execution}` } });
}

test("a harmful revision can fall back to a still applicable user-supported ancestor without changing an active pointer", () => {
  const fx = pair(), view = { ...fx.view, feedback: [judgment("version:parent", "helped", "execution:parent"), judgment("version:child", "harmed", "execution:child")] };
  const selected = selectWorkflowImprovement(view, fx.fixture.opportunity.task, {});
  assert.equal(selected?.versionId, "version:parent");
  assert.equal(selected?.fallbackFromVersionId, "version:child");
  assert.equal(selected?.reputation.standing, "user_supported");
  assert.equal(view.versions[1]?.versionId, "version:child", "fallback is a read projection, not a rewritten head");
});

test("fallback never crosses a later unfulfilled user correction or revives a harmed ancestor", () => {
  const fx = pair(), feedback = [judgment("version:parent", "helped", "execution:parent"), judgment("version:child", "harmed", "execution:child")];
  const correction = { ...fx.fixture.opportunity, opportunityId: "opportunity:later-correction", trigger: "user_correction" as const, evidenceRefs: ["user:later"] };
  const pending: WorkflowImprovementBoardView = { ...fx.view, feedback, opportunities: [{ versionId: "input:later", record: {
    type: "workflow_improvement_opportunity", schemaVersion: 1, opportunity: correction,
    evidence: [{ ref: "user:later", kind: "user_correction", summary: "The user requires a different recovery condition." }],
  } }] };

  assert.equal(selectWorkflowImprovement(pending, fx.fixture.opportunity.task, {}), undefined);
  assert.equal(selectWorkflowImprovement({ ...fx.view, feedback: [...feedback, judgment("version:parent", "harmed", "execution:parent-later")] }, fx.fixture.opportunity.task, {}), undefined);
});

test("a new untried child is a bounded trial while independent reliable issues outrank unrelated fresh proposals", () => {
  const fx = pair(), feedback = [judgment("version:parent", "helped", "execution:parent")];

  assert.equal(selectWorkflowImprovement({ ...fx.view, feedback }, fx.fixture.opportunity.task, {})?.versionId, "version:child");
  const other: WorkflowImprovement = { schemaVersion: 1, type: "workflow_improvement", claim: "proposed_improvement",
    opportunity: { ...fx.child.opportunity, issueKey: "another-source-navigation-issue" },
    proposal: fx.child.proposal, evidence: fx.child.evidence };
  const separate: WorkflowImprovementBoardView = { ...fx.view, versions: [fx.view.versions[0]!, { versionId: "version:other", artifact: other, status: "eligible" }], feedback };

  assert.equal(selectWorkflowImprovement(separate, fx.fixture.opportunity.task, {})?.versionId, "version:parent");
});

test("cross-host reuse starts without positive quality or user-help credit from the original task family", () => {
  const fx = pair();
  const task = { ...fx.fixture.opportunity.task, taskFamily: { ...fx.fixture.opportunity.task.taskFamily, id: "feature-investigation", intentClass: "implement_feature" } };
  const view = { ...fx.view, versions: [fx.view.versions[0]!], feedback: [judgment("version:parent", "helped", "execution:parent")] };
  const selected = selectWorkflowImprovement(view, task, {});
  assert.equal(selected?.versionId, "version:parent");
  assert.equal(selected?.reputation.standing, "untried");
  assert.equal(selected?.reputation.userHelped, 0);
  assert.equal(selected?.reputation.qualityPasses, 0);
});
