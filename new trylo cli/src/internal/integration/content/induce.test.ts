import assert from "node:assert/strict";
import test from "node:test";
import { editSkill } from "../../learning/domains/skill/inducer.js";
import { editWorkflow } from "../../learning/domains/workflow/inducer.js";
import { mapSkillDraft } from "../content/skill.js";
import { mapWorkflowDraft } from "../content/workflow.js";
import { proposalAdmission, skillDraft, tamper, workflowDraft } from "../testing/fixtures.js";

test("a skill draft maps to a versioned tool-free proposal", () => {
  const result = mapSkillDraft(skillDraft(), proposalAdmission());

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const command = result.value[0];
  if (command?.type !== "submit_proposal") {
    throw new Error("expected submit_proposal");
  }

  assert.equal(command.proposal.assetKind, "skill");
  assert.equal(command.proposal.domain, "skill");
  assert.equal(command.proposal.candidateRef.includes(":1"), true);
  assert.deepEqual(command.proposal.requestedAuthorities, []);
});

test("an edited skill version must name its parent asset version", () => {
  const edited = editSkill(skillDraft(), { steps: ["a", "b", "c"] });
  const withoutParent = mapSkillDraft(edited, proposalAdmission());

  assert.equal(withoutParent.ok, false);

  if (!withoutParent.ok) {
    assert.equal(withoutParent.reason, "missing_base_version");
  }

  const withParent = mapSkillDraft(
    edited,
    proposalAdmission({ baseVersionId: "asset-v1" }),
  );

  assert.equal(withParent.ok, true);

  if (withParent.ok) {
    const command = withParent.value[0];
    if (command?.type === "submit_proposal") {
      assert.equal(command.proposal.baseVersionId, "asset-v1");
    }
  }
});

test("a skill draft that claims permission is rejected", () => {
  const result = mapSkillDraft(
    tamper(skillDraft(), { permissionClaim: true }),
    proposalAdmission(),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "authority_claim_present");
  }
});

test("workflow scope must be admitted because the draft has none", () => {
  const missing = mapWorkflowDraft(workflowDraft(), proposalAdmission());

  assert.equal(missing.ok, false);

  if (!missing.ok) {
    assert.equal(missing.reason, "missing_scope");
  }

  const admitted = mapWorkflowDraft(
    workflowDraft(),
    proposalAdmission({ scope: "task_family:ts-unit-fix" }),
  );

  assert.equal(admitted.ok, true);

  if (admitted.ok) {
    const command = admitted.value[0];
    if (command?.type === "submit_proposal") {
      assert.equal(command.proposal.scope, "task_family:ts-unit-fix");
      assert.equal(command.proposal.assetKind, "workflow");
    }
  }
});

test("a workflow cannot change team topology", () => {
  const result = mapWorkflowDraft(
    tamper(workflowDraft(), { teamTopologyChanged: true }),
    proposalAdmission({ scope: "task_family:ts-unit-fix" }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "authority_claim_present");
  }
});

test("an edited workflow version must name its parent asset version", () => {
  const edited = editWorkflow(workflowDraft(), {
    budget: { maxSteps: 3, maxTokens: 100, maxWallMs: 1000 },
  });
  const result = mapWorkflowDraft(edited, proposalAdmission({ scope: "task_family:ts-unit-fix" }));

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "missing_base_version");
  }
});
