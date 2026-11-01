import assert from "node:assert/strict";
import test from "node:test";
import { command, inferredDraft, passEvidence } from "./fixtures.js";
import { reduceAll, reduce } from "./reducer.js";
import { emptyBoardState } from "./state.js";

test("shadow replacement retains its predecessor, refuses stale owners and restores a clean pointer on rollback", () => {
  const first = inferredDraft({ proposalId: "replace-first" }), second = inferredDraft({ proposalId: "replace-second" });
  const steps = [first, second].flatMap((draft, i) => [
    command("submit_proposal", { proposal: draft }), command("quarantine", { proposalId: draft.proposalId }), command("start_evaluation", { proposalId: draft.proposalId }),
    command("commit_asset", { proposalId: draft.proposalId, versionId: `v${i}`, content: { test: i }, schemaVersion: 1 }),
    command("record_evidence", { evidence: passEvidence(draft.proposalId) }), command("enter_shadow", { proposalId: draft.proposalId, versionId: `v${i}` }),
    command("request_approval", { proposalId: draft.proposalId, approvalId: `a${i}`, action: "activate" }),
    command("record_approval_decision", { approvalId: `a${i}`, status: "granted" }), command("activate", { proposalId: draft.proposalId, versionId: `v${i}` }),
  ]);
  const active = reduceAll(emptyBoardState(), steps); assert.ok(active.ok);
  assert.equal(active.state.activations[0]?.previousVersionId, "v0");
  const stale = reduce(active.state, command("suspend", { proposalId: first.proposalId, breakerReason: "stale" })); assert.equal(stale.ok, false);
  const suspended = reduce(active.state, command("suspend", { proposalId: second.proposalId, breakerReason: "current-failed" })); assert.ok(suspended.ok);
  const rolled = reduce(suspended.state, command("rollback", { proposalId: second.proposalId, reason: "restore" })); assert.ok(rolled.ok);
  assert.equal(rolled.state.activations[0]?.versionId, "v0"); assert.equal(rolled.state.activations[0]?.pointer, "active");
  assert.equal(rolled.state.activations[0]?.breaker, undefined);
  assert.equal(reduce(rolled.state, command("retire", { proposalId: second.proposalId })).ok, false);
});
