import assert from "node:assert/strict";
import test from "node:test";
import type { ToolBindingDraft } from "../../../../../../tooling/contract/types.js";
import { bindingAdmission, tamper } from "../../../../../../integration/testing/fixtures.js";
import { mapToolBinding } from "./binding.js";

const draft: ToolBindingDraft = {
  draftId: "bind-1",
  scope: "docs",
  taskFamily: "docs",
  packageVersionId: "pkg:pdf-lint:1.0.0",
  candidateId: "cand-mit",
};

test("a binding proposal references the package version and requests no authority", () => {
  const result = mapToolBinding(draft, bindingAdmission());

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const command = result.value[0];
  if (command?.type !== "submit_proposal") {
    throw new Error("expected submit_proposal");
  }

  assert.equal(command.proposal.assetKind, "tool_binding");
  assert.equal(command.proposal.candidateRef, "tool_binding:pkg:pdf-lint:1.0.0");
  assert.deepEqual(command.proposal.requestedAuthorities, []);
  assert.deepEqual(command.proposal.requiredVerifiers, ["tool_validation_pipeline"]);
});

test("a binding without a version or observation link is rejected", () => {
  const noVersion = mapToolBinding(
    tamper(draft, { packageVersionId: "" }),
    bindingAdmission(),
  );

  assert.equal(noVersion.ok, false);

  if (!noVersion.ok) {
    assert.equal(noVersion.reason, "missing_version_link");
  }

  const noObservation = mapToolBinding(draft, bindingAdmission({ observationRefs: [] }));

  assert.equal(noObservation.ok, false);

  if (!noObservation.ok) {
    assert.equal(noObservation.reason, "missing_observation_link");
  }

  const noFamily = mapToolBinding(tamper(draft, { taskFamily: "" }), bindingAdmission());

  assert.equal(noFamily.ok, false);

  if (!noFamily.ok) {
    assert.equal(noFamily.reason, "missing_task_family");
  }
});
