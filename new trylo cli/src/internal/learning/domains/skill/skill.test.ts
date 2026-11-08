import assert from "node:assert/strict";
import test from "node:test";
import { classifyLearningShape } from "../shared/classify.js";
import type { SkillEpisode } from "./inducer.js";
import { induceSkill } from "./inducer.js";
import type { TaskFamily } from "../shared/types.js";

const family: TaskFamily = {
  id: "ts-unit-fix",
  intentClass: "fix_failing_unit_test",
  checkKind: "unit_test",
  language: "ts",
};

function episode(
  id: string,
  outcome: "success" | "failure",
  failureMode?: string,
): SkillEpisode {
  const base = {
    id,
    taskFamily: family,
    trajectory: {
      nodeIds: ["repro", "patch", "verify"],
      stepCount: 3,
      hadFailureRecovery: outcome === "failure",
      hadChecks: true,
    },
    outcome,
    steps: ["reproduce failing test", "patch the production code", "re-run the same test"],
    checks: ["unit_test exit 0"],
  };

  if (failureMode === undefined) {
    return base;
  }

  return { ...base, failureMode };
}

test("three similar multi-step episodes induce a skill draft with pos/neg/checks", () => {
  const result = induceSkill([
    episode("s1", "success"),
    episode("s2", "success"),
    episode("f1", "failure", "patched tests instead of production code"),
  ]);

  assert.equal(result.kind, "draft");

  if (result.kind !== "draft") {
    return;
  }

  assert.equal(result.draft.status, "draft");
  assert.ok(result.draft.trigger.length > 0);
  assert.equal(result.draft.steps.length >= 3, true);
  assert.equal(result.draft.checks.length > 0, true);
  assert.equal(result.draft.failureModes.length > 0, true);
  assert.equal(result.draft.positiveExamples.length > 0, true);
  assert.equal(result.draft.negativeExamples.length > 0, true);
  assert.equal(result.draft.provenance.createdBy, "skill_inducer");
  assert.equal(result.draft.scope.kind, "task_family");
  assert.equal(result.draft.permissionClaim, false);
  assert.equal(result.draft.version, 1);
});

test("same-name improvement suggests a new version instead of in-place write", () => {
  const first = induceSkill([
    episode("s1", "success"),
    episode("s2", "success"),
    episode("f1", "failure", "skipped verify"),
  ]);

  assert.equal(first.kind, "draft");

  if (first.kind !== "draft") {
    return;
  }

  const second = induceSkill(
    [episode("s3", "success"), episode("s4", "success"), episode("f2", "failure", "flaky setup")],
    [first.draft.version],
  );

  assert.equal(second.kind, "draft");

  if (second.kind === "draft") {
    assert.equal(second.draft.version, 2);
    assert.notEqual(second.draft.id, first.draft.id);
  }
});

test("a single better phrasing is not a skill", () => {
  const result = induceSkill([
    {
      id: "p1",
      taskFamily: family,
      trajectory: {
        nodeIds: ["say"],
        stepCount: 1,
        hadFailureRecovery: false,
        hadChecks: false,
      },
      outcome: "success",
      steps: ["please be careful"],
      checks: [],
    },
  ]);

  assert.equal(result.kind, "failure");

  if (result.kind === "failure") {
    assert.equal(result.code, "needs_more_evidence");
  }

  const classified = classifyLearningShape({
    explicitFutureDirective: false,
    phrasingOnly: true,
    multiStepWithChecks: false,
    processGraph: false,
  });

  assert.equal(classified.kind, "prompt_patch");
});
