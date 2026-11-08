import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "./hash.js";
import {
  command,
  inferredDraft,
  passEvidence,
  proposalOf,
  resetIds,
  userRuleDraft,
} from "./fixtures.js";
import { reduce, reduceAll } from "./reducer.js";
import { emptyBoardState } from "./state.js";

test("duplicate commandId is idempotent and does not advance sequence twice", () => {
  resetIds();
  const draft = userRuleDraft();
  const submit = command("submit_proposal", { proposal: draft, commandId: "same" });
  const first = reduce(emptyBoardState(), submit);

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  const second = reduce(first.state, submit);

  assert.equal(second.ok, true);

  if (second.ok) {
    assert.equal(second.idempotent, true);
    assert.equal(second.events.length, 0);
    assert.equal(second.state.sequence, first.state.sequence);
  }
});

test("inferred proposal cannot use fast lane", () => {
  resetIds();
  const draft = inferredDraft();
  const prepared = reduce(
    emptyBoardState(),
    command("submit_proposal", { proposal: draft }),
  );

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  const result = reduce(
    prepared.state,
    command("fast_lane_validate", { proposalId: draft.proposalId }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "inferred_cannot_skip_verification");
  }
});

test("fast lane rejects wrong kind, global scope, and authorities", () => {
  resetIds();
  const cases = [
    {
      draft: userRuleDraft({ assetKind: "workflow", domain: "workflow" }),
      reason: "fast_lane_wrong_kind",
    },
    {
      draft: userRuleDraft({ scope: "global" }),
      reason: "fast_lane_scope_rejected",
    },
    {
      draft: userRuleDraft({ requestedAuthorities: ["install"] }),
      reason: "fast_lane_authority_rejected",
    },
    {
      draft: userRuleDraft({ assetKind: "tool_package", domain: "tool" }),
      reason: "fast_lane_wrong_kind",
    },
    {
      draft: userRuleDraft({ risk: "high" }),
      reason: "fast_lane_risk_rejected",
    },
  ] as const;

  for (const item of cases) {
    const prepared = reduce(
      emptyBoardState(),
      command("submit_proposal", { proposal: item.draft }),
    );

    assert.equal(prepared.ok, true);

    if (!prepared.ok) {
      continue;
    }

    const result = reduce(
      prepared.state,
      command("fast_lane_validate", { proposalId: item.draft.proposalId }),
    );

    assert.equal(result.ok, false, item.reason);

    if (!result.ok) {
      assert.equal(result.reason, item.reason);
    }
  }
});

test("llm critique cannot produce external pass", () => {
  resetIds();
  const draft = inferredDraft();
  const prepared = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: draft.proposalId }),
    command("start_evaluation", { proposalId: draft.proposalId }),
  ]);

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  const result = reduce(
    prepared.state,
    command("record_evidence", {
      evidence: passEvidence(draft.proposalId, { kinds: ["llm_critique"] }),
    }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "llm_critique_cannot_pass");
  }
});

test("shadow requires independent external pass", () => {
  resetIds();
  const draft = inferredDraft();
  const versionId = "v-shadow";
  const prepared = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: draft.proposalId }),
    command("start_evaluation", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId,
      content: { text: "x" },
      schemaVersion: 1,
    }),
  ]);

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  const result = reduce(
    prepared.state,
    command("enter_shadow", { proposalId: draft.proposalId, versionId }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "external_pass_required");
  }
});

test("denied approval rejects the proposal and does not activate", () => {
  resetIds();
  const draft = inferredDraft();
  const prepared = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: draft.proposalId }),
    command("start_evaluation", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId: "v1",
      content: { text: "x" },
      schemaVersion: 1,
    }),
    command("record_evidence", { evidence: passEvidence(draft.proposalId) }),
    command("enter_shadow", { proposalId: draft.proposalId, versionId: "v1" }),
    command("request_approval", {
      proposalId: draft.proposalId,
      approvalId: "ap-deny",
      action: "activate",
    }),
    command("record_approval_decision", { approvalId: "ap-deny", status: "denied" }),
  ]);

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  assert.equal(proposalOf(prepared.state, draft.proposalId).lifecycle, "rejected");
  const activated = reduce(
    prepared.state,
    command("activate", { proposalId: draft.proposalId, versionId: "v1" }),
  );

  assert.equal(activated.ok, false);

  if (!activated.ok) {
    assert.equal(activated.reason, "illegal_transition");
  }
});

test("unknown command type fails closed", () => {
  const result = reduce(emptyBoardState(), {
    type: "not_a_command",
    commandId: "c-unknown",
    issuedAt: "2026-09-12T00:00:00.000Z",
  } as never);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "unknown_command");
    assert.equal(result.state.sequence, 0);
  }
});

test("resume CAS mismatch fail closed", () => {
  resetIds();
  const draft = userRuleDraft();
  const prepared = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("fast_lane_validate", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId: "v-cas",
      content: { text: "one" },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: draft.proposalId, versionId: "v-cas" }),
    command("suspend", { proposalId: draft.proposalId, breakerReason: "neg-delta" }),
  ]);

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  const generation = prepared.state.activations[0]?.generation;
  const result = reduce(
    prepared.state,
    command("resume", {
      proposalId: draft.proposalId,
      expectedGeneration: (generation ?? 0) + 99,
    }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "activation_cas_mismatch");
  }
});

test("commit_asset refuses to mutate an existing version id", () => {
  resetIds();
  const draft = userRuleDraft();
  const versionId = "v-immutable";
  const prepared = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId,
      content: { text: "one" },
      schemaVersion: 1,
    }),
  ]);

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  const result = reduce(
    prepared.state,
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId,
      content: { text: "two" },
      schemaVersion: 1,
    }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "active_content_immutable");
  }

  assert.equal(prepared.state.assets[0]?.contentHash, contentHashOf({ text: "one" }));
});

test("second activate of a different version without suspend fails", () => {
  resetIds();
  const draft = userRuleDraft();
  const first = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("fast_lane_validate", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId: "v1",
      content: { text: "one" },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: draft.proposalId, versionId: "v1" }),
  ]);

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  const secondDraft = userRuleDraft({ proposalId: "p-other" });
  const second = reduceAll(first.state, [
    command("submit_proposal", { proposal: secondDraft }),
    command("fast_lane_validate", { proposalId: secondDraft.proposalId }),
    command("commit_asset", {
      proposalId: secondDraft.proposalId,
      versionId: "v2",
      content: { text: "two" },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: secondDraft.proposalId, versionId: "v2" }),
  ]);

  assert.equal(second.ok, false);

  if (!second.ok) {
    assert.equal(second.reason, "illegal_transition");
  }
});

test("rollback moves pointer and leaves asset content hash unchanged", () => {
  resetIds();
  const first = userRuleDraft({ proposalId: "p1" });
  const second = userRuleDraft({ proposalId: "p2" });
  const started = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: first }),
    command("fast_lane_validate", { proposalId: first.proposalId }),
    command("commit_asset", {
      proposalId: first.proposalId,
      versionId: "v1",
      content: { text: "one" },
      schemaVersion: 1,
    }),
    command("activate", { proposalId: first.proposalId, versionId: "v1" }),
    command("suspend", { proposalId: first.proposalId, breakerReason: "swap" }),
    command("submit_proposal", { proposal: second }),
    command("fast_lane_validate", { proposalId: second.proposalId }),
    command("commit_asset", {
      proposalId: second.proposalId,
      versionId: "v2",
      content: { text: "two" },
      schemaVersion: 1,
    }),
  ]);

  assert.equal(started.ok, true);

  if (!started.ok) {
    return;
  }

  const activated = reduce(
    started.state,
    command("activate", { proposalId: second.proposalId, versionId: "v2" }),
  );

  assert.equal(activated.ok, true);

  if (!activated.ok) {
    return;
  }

  const suspended = reduce(
    activated.state,
    command("suspend", { proposalId: second.proposalId, breakerReason: "neg" }),
  );

  assert.equal(suspended.ok, true);

  if (!suspended.ok) {
    return;
  }

  const rolled = reduce(
    suspended.state,
    command("rollback", { proposalId: second.proposalId, reason: "restore" }),
  );

  assert.equal(rolled.ok, true);

  if (!rolled.ok) {
    return;
  }

  const activation = rolled.state.activations[0];

  assert.equal(activation?.versionId, "v1");
  assert.equal(activation?.pointer, "active");
  assert.equal(rolled.state.assets[0]?.contentHash, contentHashOf({ text: "one" }));
  assert.equal(rolled.state.assets[1]?.contentHash, contentHashOf({ text: "two" }));
  assert.equal(proposalOf(rolled.state, second.proposalId).lifecycle, "rolled_back");
});

test("compound proposal without children is rejected", () => {
  resetIds();
  const draft = inferredDraft({ domain: "compound" });
  const result = reduce(emptyBoardState(), command("submit_proposal", { proposal: draft }));

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "compound_must_be_explicit");
  }
});

test("awaiting_approval without grant cannot activate", () => {
  resetIds();
  const draft = inferredDraft();
  const prepared = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: draft.proposalId }),
    command("start_evaluation", { proposalId: draft.proposalId }),
    command("commit_asset", {
      proposalId: draft.proposalId,
      versionId: "v1",
      content: { text: "x" },
      schemaVersion: 1,
    }),
    command("record_evidence", { evidence: passEvidence(draft.proposalId) }),
    command("enter_shadow", { proposalId: draft.proposalId, versionId: "v1" }),
    command("request_approval", {
      proposalId: draft.proposalId,
      approvalId: "ap1",
      action: "activate",
    }),
  ]);

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  const result = reduce(
    prepared.state,
    command("activate", { proposalId: draft.proposalId, versionId: "v1" }),
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "approval_not_granted");
  }
});
