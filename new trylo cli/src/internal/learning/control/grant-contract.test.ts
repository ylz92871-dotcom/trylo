import assert from "node:assert/strict";
import test from "node:test";
import type { LearningGrantDraft } from "./grant-contract.js";
import { isLearningGrantDraft, isLearningGrantUsage } from "./grant-parse.js";
import { learningGrantSnapshots } from "./grant-state.js";
import { reduce } from "./reducer.js";
import { emptyBoardState, normalizeBoardState, type BoardState } from "./state.js";

const open: LearningGrantDraft = { schemaVersion: 1, kind: "open", grantId: "grant-a", subsystem: "skill",
  workspaceId: "workspace-a", sourceRef: "execution:session:turn", allowance: { maxCalls: 2, maxOutputTokens: 10 } };

function apply(state: BoardState, fact: LearningGrantDraft, id = `${fact.kind}-${state.sequence}`) {
  return reduce(state, { type: "record_learning_grant_fact", commandId: id, issuedAt: "2026-11-03T00:00:00Z", fact });
}

function next(state: BoardState, fact: LearningGrantDraft): BoardState {
  const result = apply(state, fact);
  assert.ok(result.ok, JSON.stringify(result));
  return result.state;
}

const reserve = (reservationId: string, maxOutputTokens = 10): LearningGrantDraft => ({ schemaVersion: 1, kind: "reserve", grantId: "grant-a", reservationId, maxOutputTokens });
const settle = (outputTokens: number): LearningGrantDraft => ({ schemaVersion: 1, kind: "settle", grantId: "grant-a", reservationId: "r1",
  usage: { kind: "reported", inputTokens: 2, outputTokens, totalTokens: 2 + outputTokens } });

test("grant facts use closed validated contracts and old snapshots default only an absent ledger", () => {
  assert.equal(isLearningGrantDraft(open), true);
  assert.equal(isLearningGrantDraft({ ...open, permission: "shell" }), false);
  assert.equal(isLearningGrantDraft({ ...open, allowance: { maxCalls: 129, maxOutputTokens: 10 } }), false);
  assert.equal(isLearningGrantUsage({ kind: "reported", inputTokens: 4, outputTokens: 5, totalTokens: 8 }), false);
  assert.deepEqual(normalizeBoardState(emptyBoardState())?.learningGrantFacts, []);
  const malformed = JSON.parse(JSON.stringify({ ...emptyBoardState(), learningGrantFacts: null }));

  assert.equal(normalizeBoardState(malformed), undefined);
});

test("Board is the sole grant transition owner and reserves before output is spent", () => {
  assert.equal(apply(emptyBoardState(), reserve("r1")).ok, false);
  let state = next(emptyBoardState(), open);
  state = next(state, reserve("r1"));
  const blocked = apply(state, reserve("r2"));
  assert.equal(blocked.ok, false);

  if (!blocked.ok) assert.equal(blocked.reason, "learning_grant_unsettled");

  state = next(state, settle(6));
  assert.equal(apply(state, reserve("r2", 5)).ok, false);
  state = next(state, reserve("r2", 4));
  const snapshot = learningGrantSnapshots(state.learningGrantFacts ?? [])?.get("grant-a");

  assert.equal(snapshot?.callsReserved, 2);
  assert.equal(snapshot?.reportedOutputTokens, 6);
  assert.equal(state.assets.length, 0);
  assert.equal(state.approvals.length, 0);
});

test("unknown and observed overruns survive as blocking states without a zero usage refund", () => {
  const reserved = next(next(emptyBoardState(), open), reserve("r1"));
  const unknown = next(reserved, { schemaVersion: 1, kind: "settle", grantId: "grant-a", reservationId: "r1", usage: { kind: "unknown", reason: "crash" } });

  assert.equal(learningGrantSnapshots(unknown.learningGrantFacts ?? [])?.get("grant-a")?.status, "unknown");
  assert.equal(apply(unknown, reserve("r2")).ok, false);
  const overrun = next(reserved, { schemaVersion: 1, kind: "settle", grantId: "grant-a", reservationId: "r1", usage: { kind: "unknown", reason: "partial", observed: { outputTokens: 11 } } });

  assert.equal(learningGrantSnapshots(overrun.learningGrantFacts ?? [])?.get("grant-a")?.status, "overrun");
  assert.equal(apply(overrun, reserve("r2")).ok, false);
});

test("grant command replay requires the same payload and fact sequence is checked", () => {
  const first = apply(emptyBoardState(), open, "same");
  assert.ok(first.ok);
  const replay = apply(first.state, open, "same");
  assert.ok(replay.ok);
  assert.equal(replay.idempotent, true);
  const conflicting = apply(first.state, { ...open, sourceRef: "changed" }, "same");
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok) assert.equal(conflicting.reason, "command_payload_conflict");
  const facts = first.state.learningGrantFacts;
  assert.ok(facts);
  assert.equal(learningGrantSnapshots([...facts, { ...open, grantId: "grant-b", boardSequence: 1 }]), undefined);
});

test("closed grants cannot reserve while terminal usage can still reconcile an in-flight call", () => {
  let state = next(next(emptyBoardState(), open), reserve("r1"));
  state = next(state, { schemaVersion: 1, kind: "close", grantId: "grant-a", reason: "cancelled" });
  assert.equal(apply(state, reserve("r2")).ok, false);
  state = next(state, settle(4));
  const snapshot = learningGrantSnapshots(state.learningGrantFacts ?? [])?.get("grant-a");
  assert.equal(snapshot?.status, "closed");
  assert.equal(snapshot?.reportedOutputTokens, 4);
});
