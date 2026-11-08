import assert from "node:assert/strict";
import test from "node:test";
import { mapPromptPatchDraft } from "./prompt-patch.js";
import { promptPatchDraft, proposalAdmission, tamper } from "../../../../../../integration/testing/fixtures.js";

test("an inferred prompt improvement is only a proposal", () => {
  const result = mapPromptPatchDraft(promptPatchDraft(), proposalAdmission());

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  const command = result.value[0];
  if (command?.type !== "submit_proposal") {
    throw new Error("expected submit_proposal");
  }

  assert.equal(command.proposal.assetKind, "prompt_patch");
  assert.equal(command.proposal.domain, "prompt");
  assert.deepEqual(command.proposal.observationRefs, ["obs-1", "obs-2"]);
  assert.deepEqual(command.proposal.requestedAuthorities, []);
});

test("external_verdict target metric without an independent verifier is rejected", () => {
  const result = mapPromptPatchDraft(
    promptPatchDraft(),
    proposalAdmission({ requiredVerifiers: [] }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "missing_verifier");
  }
});

test("attribution needs two causal observation refs", () => {
  const draft = promptPatchDraft();
  const result = mapPromptPatchDraft(
    tamper(draft, { causalObservationRefs: ["obs-1"] }),
    proposalAdmission(),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "insufficient_attribution");
  }
});

test("a draft claiming activation eligibility is not a draft", () => {
  const result = mapPromptPatchDraft(
    tamper(promptPatchDraft(), { activationEligible: true }),
    proposalAdmission(),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "not_a_draft");
  }
});
