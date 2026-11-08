import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { CollaborationBoardPort } from "../domain/contracts.js";
import type { CollaborationCheckReceiptV2, CollaborationCheckSubjectV2, CollaborationCheckerReaderV2 } from "../domain/v2-checker.js";
import type { CollaborationV2Context } from "../domain/v2-contracts.js";
import { createCollaborationCheckerFeedbackV2 } from "./checker-feedback-v2.js";

const NOW = "2026-11-03T00:00:00.000Z";
const context: CollaborationV2Context = { scope: "workspace:checked", teamRunId: "team", taskId: "team", memberId: "parent", role: "parent",
  round: 1, taskFamily: "unknown", dependency: "unknown", coordinationMode: "unknown", difficulty: "unknown",
  members: [{ memberId: "worker", role: "worker" }, { memberId: "reviewer", role: "reviewer" }] };
const subject: CollaborationCheckSubjectV2 = { scope: context.scope, teamRunId: "team", taskId: "team", memberId: "parent", round: 1,
  episodeId: "actual-result", artifactRef: "artifact:delivery", contentHash: "a".repeat(64), requirementsDigest: "b".repeat(64), generatorId: "team-generator" };

function receipt(verdict: CollaborationCheckReceiptV2["verdict"] = "failed"): CollaborationCheckReceiptV2 {
  return { schemaVersion: 2, runRef: "check:run-1", subject, checkerId: "independent-assertions", checkerVersion: "1",
    checksDigest: "c".repeat(64), verdict, recordedAt: NOW };
}

async function harness() {
  let state = emptyBoardState();
  const board: CollaborationBoardPort = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const event = { schemaVersion: 2 as const, kind: "event" as const, factId: "actual-terminal", scope: context.scope, recordedAt: NOW,
    context, dimension: "review" as const, action: "team_terminal", summary: "Actual team stopped; delivery is not independently verified.",
    source: "runtime" as const, evidenceRefs: ["execution:actual"], causedBy: [], metrics: {} };

  assert.equal((await board.apply({ type: "record_collaboration_v2", commandId: `collaboration-v2:${event.factId}`, issuedAt: NOW, fact: event })).ok, true);
  assert.equal((await board.apply({ type: "record_collaboration_v2", commandId: `collaboration-v2:${subject.episodeId}`, issuedAt: NOW,
    fact: { schemaVersion: 2, kind: "episode", factId: subject.episodeId, scope: context.scope, recordedAt: NOW, context,
      eventIds: [event.factId], metrics: { delivery: "unverified", waitMs: 70 }, source: "runtime", evidenceRefs: [event.factId] } })).ok, true);

  return { board, state: () => state };
}

test("actual checker failure is retained with immutable execution/digest provenance and idempotent replay", async () => {
  const h = await harness();
  let wakes = 0;
  const adapter = createCollaborationCheckerFeedbackV2({ board: h.board, checker: { read: async () => ({ ok: true, receipt: receipt() }) },
    onRecorded: () => {
      wakes += 1;
      throw new Error("observer failed");
    } });
  const result = await adapter.record({ runRef: "check:run-1", subject });

  assert.ok(result.ok);
  const sequence = h.state().sequence;
  const outcome = h.state().collaborationV2Facts?.find(f => f.kind === "outcome");

  assert.ok(outcome?.kind === "outcome");
  assert.equal(outcome.metrics.delivery, "failed");
  assert.equal(outcome.metrics.waitMs, 70);
  assert.deepEqual(outcome.adoptionIds, [], "a check must not invent practice adoption");
  assert.ok(outcome.evidenceRefs.includes(`source-sha256:${subject.contentHash}`));
  assert.equal((await adapter.record({ runRef: "check:run-1", subject })).ok, true);
  assert.equal(h.state().sequence, sequence);
  assert.equal(wakes, 2);
});

test("missing reader, forged/mismatched subject and self-check identity cannot claim independent delivery", async () => {
  for (const mutate of [(r: CollaborationCheckReceiptV2) => ({ ...r, subject: { ...r.subject, contentHash: "d".repeat(64) } }),
    (r: CollaborationCheckReceiptV2) => ({ ...r, checkerId: subject.generatorId }),
    (r: CollaborationCheckReceiptV2) => ({ ...r, subject: { ...r.subject, round: 2 } })]) {
    const h = await harness(), sequence = h.state().sequence;
    const reader: CollaborationCheckerReaderV2 = { read: async () => ({ ok: true, receipt: mutate(receipt("passed")) }) };
    const result = await createCollaborationCheckerFeedbackV2({ board: h.board, checker: reader }).record({ runRef: "check:run-1", subject });
    assert.equal(result.ok, false);
    assert.equal(h.state().sequence, sequence);
  }

  const h = await harness();

  assert.equal((await createCollaborationCheckerFeedbackV2({ board: h.board }).record({ runRef: "check:run-1", subject })).ok, false);
  const badSubject = { ...subject, episodeId: "unobserved-task" };

  assert.equal((await createCollaborationCheckerFeedbackV2({ board: h.board, checker: { read: async () => ({ ok: true,
    receipt: { ...receipt("passed"), subject: badSubject } }) } }).record({ runRef: "check:run-1", subject: badSubject })).ok, false);
});

test("partial checks remain unverified and collection withdrawal discards late checker output", async () => {
  const h = await harness();
  let enabled = true;
  const reader: CollaborationCheckerReaderV2 = { read: async () => ({ ok: true, receipt: receipt("partial") }) };

  assert.equal((await createCollaborationCheckerFeedbackV2({ board: h.board, checker: reader }).record({ runRef: "check:run-1", subject })).ok, true);
  assert.equal(h.state().collaborationV2Facts?.find(f => f.kind === "outcome")?.metrics.delivery, "unverified");
  const sequence = h.state().sequence;
  const late: CollaborationCheckerReaderV2 = { read: async () => {
    enabled = false;
    return { ok: true, receipt: receipt("passed") };
  } };

  assert.equal((await createCollaborationCheckerFeedbackV2({ board: h.board, checker: late, enabled: () => enabled }).record({ runRef: "check:run-1", subject })).ok, false);
  assert.equal(h.state().sequence, sequence);
});

test("a checker return value cannot mutate its verified verdict while Board IO is pending", async () => {
  const h = await harness(), returned = { ...receipt() };
  const board: CollaborationBoardPort = { ...h.board, async load() {
    returned.verdict = "passed";
    returned.checkerId = subject.generatorId;
    return h.board.load();
  } };
  const result = await createCollaborationCheckerFeedbackV2({ board, checker: { read: async () => ({ ok: true, receipt: returned }) } }).record({ runRef: "check:run-1", subject });

  assert.ok(result.ok);
  const outcome = h.state().collaborationV2Facts?.find(f => f.kind === "outcome");

  assert.ok(outcome?.kind === "outcome");
  assert.equal(outcome.metrics.delivery, "failed");
  assert.ok(outcome.evidenceRefs.includes("checker:independent-assertions@1"));
});

test("collection withdrawal during Board reads prevents new independent feedback facts", async () => {
  const h = await harness();
  let enabled = true;
  const sequence = h.state().sequence;
  const board: CollaborationBoardPort = { ...h.board, async load() {
    enabled = false;
    return h.board.load();
  } };
  const result = await createCollaborationCheckerFeedbackV2({ board, enabled: () => enabled, checker: { read: async () => ({ ok: true, receipt: receipt("passed") }) } }).record({ runRef: "check:run-1", subject });
  assert.equal(result.ok, false);
  assert.equal(h.state().sequence, sequence);
});
