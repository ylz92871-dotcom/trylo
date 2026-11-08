import assert from "node:assert/strict";
import test from "node:test";
import { classifyLearningShape } from "../../../../domains/shared/classify.js";
import { ruleIdentity } from "../../../../domains/shared/dual-save.js";
import { induceSkill, type SkillEpisode } from "../../../../domains/skill/inducer.js";
import type { TaskFamily } from "../../../../domains/shared/types.js";
import { induceWorkflow, type WorkflowEpisode } from "./inducer.js";

const family: TaskFamily = {
  id: "ts-unit-fix",
  intentClass: "fix_failing_unit_test",
  checkKind: "unit_test",
};

function flow(id: string, outcome: "success" | "failure"): WorkflowEpisode {
  return {
    id,
    taskFamily: family,
    trajectory: {
      nodeIds: ["repro", "patch", "verify"],
      stepCount: 3,
      hadFailureRecovery: true,
      hadChecks: true,
    },
    nodeInputs: { repro: "failing test", patch: "diff", verify: "command" },
    nodeOutputs: { repro: "stack", patch: "files", verify: "exit_code" },
    fallback: "repro",
    outcome,
  };
}

test("stable nodes, transitions, and fallback induce a workflow draft", () => {
  const result = induceWorkflow([flow("w1", "success"), flow("w2", "failure")]);

  assert.equal(result.kind, "draft");

  if (result.kind !== "draft") {
    return;
  }

  assert.equal(result.draft.nodes.length, 3);
  assert.equal(result.draft.transitions.length, 2);
  assert.equal(result.draft.budget.maxSteps > 0, true);
  assert.equal(result.draft.verificationCheckpoints.length > 0, true);
  assert.equal(result.draft.failureFallback.length > 0, true);
  assert.equal(result.draft.mutableFields.includes("budget.maxSteps"), true);
  assert.equal(result.draft.version, 1);
  assert.equal(result.draft.source, "trajectory-induction");
  assert.equal(result.draft.teamTopologyChanged, false);
  assert.equal(result.draft.permissionClaim, false);
  assert.equal(result.draft.status, "draft");
});

test("insufficient repeats stay as needs_more_evidence", () => {
  const result = induceWorkflow([flow("w1", "success")]);
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.code, "needs_more_evidence");
  }
});

test("the same rule is not saved as both skill and workflow", () => {
  const nodes = ["repro", "patch", "verify"];
  const classified = classifyLearningShape({
    explicitFutureDirective: false,
    phrasingOnly: false,
    multiStepWithChecks: true,
    processGraph: true,
    skillIdentity: ruleIdentity(nodes),
    workflowIdentity: ruleIdentity(nodes),
  });

  assert.equal(classified.kind, "compound_proposal_suggestion");

  if (classified.kind === "compound_proposal_suggestion") {
    assert.equal(classified.activationEligible, false);
    assert.deepEqual(classified.parts, ["skill", "workflow"]);
  }

  const skillEpisodes: SkillEpisode[] = [
    {
      id: "s1",
      taskFamily: family,
      trajectory: { nodeIds: nodes, stepCount: 3, hadFailureRecovery: false, hadChecks: true },
      outcome: "success",
      steps: nodes,
      checks: ["unit_test"],
    },
    {
      id: "s2",
      taskFamily: family,
      trajectory: { nodeIds: nodes, stepCount: 3, hadFailureRecovery: false, hadChecks: true },
      outcome: "success",
      steps: nodes,
      checks: ["unit_test"],
    },
    {
      id: "s3",
      taskFamily: family,
      trajectory: { nodeIds: nodes, stepCount: 3, hadFailureRecovery: true, hadChecks: true },
      outcome: "failure",
      steps: nodes,
      checks: ["unit_test"],
      failureMode: "skipped verify",
    },
  ];
  const skill = induceSkill(skillEpisodes);
  const workflow = induceWorkflow([flow("w1", "success"), flow("w2", "failure")]);

  assert.equal(skill.kind, "draft");
  assert.equal(workflow.kind, "draft");

  if (skill.kind === "draft" && workflow.kind === "draft") {
    assert.equal(skill.draft.identity, workflow.draft.identity);
    const blocked = classifyLearningShape({
      explicitFutureDirective: false,
      phrasingOnly: false,
      multiStepWithChecks: true,
      processGraph: true,
      skillIdentity: skill.draft.identity,
      workflowIdentity: workflow.draft.identity,
    });

    assert.equal(blocked.kind, "compound_proposal_suggestion");

    if (blocked.kind === "compound_proposal_suggestion") {
      assert.equal(blocked.activationEligible, false);
    }
  }
});
