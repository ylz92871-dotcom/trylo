import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../../../control/state.js";
import { skillApprovalDraft } from "./lifecycle.js";
import { isSkillLifecycleObservation, readSkillLifecycleFacts, skillLifecycleDraft,
  type SkillApprovalObservation, type SkillLoadObservation } from "./lifecycle-facts.js";

const scope = "workspace:lifecycle";
const approval: SkillApprovalObservation = { schemaVersion: 1, kind: "native_approved", at: "2026-11-04T13:00:00.000Z",
  issueId: "issue:one", grantId: "grant:one", jobId: "job:one", pendingRef: "hermes-pending:skills:native-one",
  payloadHash: `sha256:${"a".repeat(64)}`, action: "create", name: "release-manifest", instructionHash: "b".repeat(64) };

function approvedFact() {
  const draft = skillLifecycleDraft(scope, approval);
  assert.ok(draft);
  return { ...draft, sequence: 1 };
}

function load(approvalRef: string): SkillLoadObservation {
  return { schemaVersion: 1, kind: "instruction_loaded", at: "2026-11-04T13:00:01.000Z",
    issueId: approval.issueId, grantId: approval.grantId, jobId: approval.jobId, pendingRef: approval.pendingRef,
    approvalRef, name: approval.name, instructionHash: approval.instructionHash!, renderedContentHash: "c".repeat(64),
    sessionId: "session:later", turnId: "turn:later", toolCallId: "call:actual-read", transcriptSequence: 12, journalSequence: 20 };
}

test("lifecycle payload is closed and old Boards preserve unknown rather than a fabricated failure", () => {
  assert.deepEqual(readSkillLifecycleFacts([], scope), { status: "ready", records: [] });
  assert.equal(isSkillLifecycleObservation({ ...approval, adopted: true }), false);
  assert.equal(isSkillLifecycleObservation({ ...approval, kind: "completed" }), false);
  assert.equal(isSkillLifecycleObservation({ ...approval, pendingRef: "hermes-pending:skills:" }), false);
  assert.equal(isSkillLifecycleObservation({ ...approval, action: "write_file" }), false);
  const fact = approvedFact();

  assert.equal(readSkillLifecycleFacts([{ ...fact, payloadJson: JSON.stringify({ ...approval, name: "substituted" }) }], scope).status, "invalid");
});

test("an instruction load binds exact approved hash, source and a later journal observation", () => {
  const fact = approvedFact(), exact = load(fact.id);
  for (const change of [{}, { instructionHash: "d".repeat(64) }, { issueId: "issue:other" }, { at: approval.at }]) {
    const draft = skillLifecycleDraft(scope, { ...exact, ...change });
    assert.ok(draft);
    const parsed = readSkillLifecycleFacts([fact, { ...draft, sequence: 2 }], scope);
    assert.equal(parsed.status, Object.keys(change).length === 0 ? "ready" : "invalid");
  }
});

test("unknown native commit, absent pending and backup metadata cannot fabricate an approved source", () => {
  for (const reply of [{ ok: true, result: { success: true, committed: false } },
    { ok: true, result: { success: true, committed: true, snapshotId: "pre-apply-only" } },
    { ok: true, pending: [] }, { status: "completed" }]) {
    assert.equal(skillApprovalDraft({ board: emptyBoardState(), pendingId: "native-one", expectedHash: approval.payloadHash,
      reply, at: approval.at }), undefined);
  }
});
