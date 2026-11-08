import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore } from "../../../../../adapters/learning-store/file-event-store.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState, normalizeBoardState, type BoardState } from "../../../../control/state.js";
import type { CollaborationBoardPort, CollaborationContext, CollaborationCorrection, CollaborationEpisode,
  CollaborationFielding, CollaborationOutcome } from "./contracts.js";
import { isCollaborationFact, isCollaborationPractice } from "./parse.js";
import { createCollaborationLearning } from "./service.js";

const NOW = "2026-11-03T00:00:00.000Z";
const context: CollaborationContext = { scope: "workspace:test", teamRunId: "team1", taskId: "task1", memberId: "worker1",
  role: "worker", round: 1, dependency: "artifact" };

function episode(id = "episode1"): CollaborationEpisode {
  return { schemaVersion: 1, kind: "episode", factId: id, scope: context.scope, recordedAt: NOW, context,
    assignmentRef: "assignment1", handoff: { scope: "report", artifacts: [], evidence: [], pending: [], blockers: [] },
    result: { status: "completed", check: "failed", reworkCount: 1, missingFields: ["artifacts"], capability: "sufficient",
      evidenceRefs: ["checker:missing-report"], source: "external_checker" } };
}

function memory(initial = emptyBoardState()) {
  let state = initial;
  const board: CollaborationBoardPort = {
    async load() { return { ok: true, state, generation: 0 }; },
    async apply(command) {
      const result = reduce(state, command);
      if (result.ok) state = result.state;
      return result;
    },
  };
  return { board, state: () => state, service: createCollaborationLearning({ board, now: () => NOW }) };
}

const grant = { subsystem: "collaboration" as const, budget: { maxEpisodes: 32, maxPromptChars: 1200 } };

async function learned() {
  const h = memory();

  assert.deepEqual(await h.service.record(episode()), { ok: true });
  const result = await h.service.invoke(grant);

  assert.equal(result.ok, true);
  const selected = await h.service.prepare({ ...context, taskId: "new-task" });

  assert.equal(selected.kind, "selected");

  if (selected.kind !== "selected") throw new Error("practice missing");

  return { ...h, selected };
}

function fielding(selected: Awaited<ReturnType<typeof learned>>["selected"], id = "fielding1"): CollaborationFielding {
  return { schemaVersion: 1, kind: "fielding", factId: id, scope: selected.context.scope, recordedAt: NOW,
    context: selected.context, versionId: selected.versionId, proposalId: selected.proposalId, requestId: `dispatch:${id}`,
    correctionIds: selected.correctionIds };
}

test("learns only checked coordination evidence, persists decisions and leaves lifecycle/permissions owned", async () => {
  const h = await learned();

  assert.equal(h.state().proposals[0]?.domain, "collaboration");
  assert.equal(h.state().proposals[0]?.lifecycle, "evaluating");
  assert.deepEqual(h.state().activations, []);
  assert.deepEqual(h.state().approvals, []);
  assert.match(h.selected.guidance, /可定位的产物路径和版本/);
  const again = await h.service.invoke(grant);

  assert.deepEqual(again, { ok: true, examined: 0, createdVersionIds: [], decisions: [] });
  assert.ok(h.state().collaborationFacts?.some(fact => fact.kind === "diagnosis" && fact.diagnosis === "coordination"));
});

test("member failure and model self-report cannot become a cooperation practice", async () => {
  const h = memory();
  const member = episode("capability");

  await h.service.record({ ...member, result: { ...member.result, capability: "insufficient" } });
  const report = episode("self-report");

  await h.service.record({ ...report, result: { ...report.result, source: "member_report", check: "unverified", capability: "unknown" } });
  const result = await h.service.invoke(grant);

  assert.equal(result.ok, true);

  if (result.ok) assert.deepEqual(result.decisions.map(item => item.diagnosis), ["member_capability", "unverified"]);

  assert.deepEqual(h.state().assets, []);
  assert.equal(isCollaborationFact({ ...report, result: { ...report.result, source: "member_report" } }), false);
  assert.equal(isCollaborationFact({ ...report, skipApproval: true }), false);
  assert.equal(isCollaborationFact({ ...report, scope: "global", context: { ...report.context, scope: "global" } }), false);
});

test("transfer uses dependency conditions and scope, with a hard character cap", async () => {
  const h = await learned();
  assert.equal((await h.service.prepare({ ...context, teamRunId: "different-team", taskId: "different-domain" })).kind, "selected");
  assert.deepEqual(await h.service.prepare({ ...context, dependency: "independent" }), { kind: "skip", reason: "dependency_not_applicable" });
  assert.equal((await h.service.prepare({ ...context, scope: "other-workspace" })).kind, "skip");
  assert.deepEqual(await h.service.prepare(context, 1), { kind: "skip", reason: "prompt_budget_exceeded" });
});

test("selected advice tells the receiving member that the declared dependency already holds even without a handoff", async () => {
  const h = await learned();
  assert.match(h.selected.guidance, /本轮已声明依赖产物/);
  assert.match(h.selected.guidance, /适用前提已经成立/);
  assert.match(h.selected.guidance, /即使未收到交接包/);
  assert.match(h.selected.guidance, /开始依赖工作前/);
  assert.match(h.selected.guidance, /先向交接者索取/);
});

test("real fielding is required for feedback; checked rework creates an immutable refined version", async () => {
  const h = await learned();
  const outcome: CollaborationOutcome = { schemaVersion: 1, kind: "outcome", factId: "feedback1", scope: context.scope,
    recordedAt: NOW, fieldingId: "fielding1", result: { ...episode().result, missingFields: ["evidence"] } };

  assert.equal((await h.service.record(outcome)).ok, false);
  assert.equal((await h.service.record(fielding(h.selected))).ok, true);
  assert.equal((await h.service.record(outcome)).ok, true);
  assert.deepEqual(await h.service.prepare(context), { kind: "skip", reason: "negative_feedback" });
  assert.equal((await h.service.invoke(grant)).ok, true);
  const next = await h.service.prepare(context);

  assert.equal(next.kind, "selected");

  if (next.kind !== "selected") return;

  assert.notEqual(next.versionId, h.selected.versionId);
  assert.match(next.guidance, /独立验收依据/);
  const refined = h.state().assets.find(item => item.versionId === next.versionId);

  assert.equal(refined?.parentVersionId, h.selected.versionId);
  assert.ok(isCollaborationPractice(refined?.content));
  assert.deepEqual(refined.content.sourceOutcomeIds, [outcome.factId]);
  assert.equal((await h.service.record({ ...outcome, factId: "second-check" })).ok, false);
});

test("once, class and longterm correction scopes govern next dispatch and future variants", async () => {
  for (const appliesTo of [{ kind: "once" as const, taskId: "exception" },
    { kind: "class" as const, dependency: "artifact" as const, role: "worker" }, { kind: "longterm" as const }]) {
    const h = await learned();
    const correction: CollaborationCorrection = { schemaVersion: 1, kind: "correction", factId: `correction:${appliesTo.kind}`,
      scope: context.scope, recordedAt: NOW, targetVersionId: h.selected.versionId, appliesTo, action: "skip", evidenceRef: "user:explicit" };

    assert.equal((await h.service.record({ ...correction, scope: "other-workspace" })).ok, false);
    assert.equal((await h.service.record(correction)).ok, true);
    assert.deepEqual(await h.service.prepare({ ...context, taskId: "exception" }), { kind: "skip", reason: "explicit_correction" });
    const ordinary = await h.service.prepare(context);

    assert.equal(ordinary.kind, appliesTo.kind === "once" ? "selected" : "skip");

    if (appliesTo.kind === "class") assert.equal((await h.service.prepare({ ...context, role: "reviewer" })).kind, "selected");

    await h.service.record(episode("later-same-pattern"));
    await h.service.invoke(grant);
    assert.deepEqual(await h.service.prepare({ ...context, taskId: "exception" }), { kind: "skip", reason: "explicit_correction" });
  }
});

test("require-evidence correction changes guidance and stale prepared fielding is rejected", async () => {
  const h = await learned();
  const correction: CollaborationCorrection = { schemaVersion: 1, kind: "correction", factId: "include-proof", scope: context.scope,
    recordedAt: NOW, targetVersionId: h.selected.versionId, appliesTo: { kind: "longterm" }, action: "require_evidence", evidenceRef: "user:proof" };

  assert.equal((await h.service.record(correction)).ok, true);
  assert.equal((await h.service.record(fielding(h.selected))).ok, false);
  const selected = await h.service.prepare(h.selected.context);

  assert.equal(selected.kind, "selected");

  if (selected.kind !== "selected") return;

  assert.match(selected.guidance, /独立验收依据/);
  assert.deepEqual(selected.correctionIds, [correction.factId]);
  assert.equal((await h.service.record(fielding(selected))).ok, true);
});

test("zero quota and collect=false avoid IO; invalid inputs fail closed", async () => {
  const board: CollaborationBoardPort = { async load() { throw new Error("unexpected IO"); }, async apply() { throw new Error("unexpected IO"); } };
  const service = createCollaborationLearning({ board, now: () => NOW });

  assert.deepEqual(await service.invoke({ ...grant, budget: { ...grant.budget, maxEpisodes: 0 } }),
    { ok: true, examined: 0, createdVersionIds: [], decisions: [] });
  assert.deepEqual(await service.invoke({ ...grant, budget: { ...grant.budget, maxEpisodes: -1 } }), { ok: false, reason: "invalid_collaboration_budget" });
  const disabled = createCollaborationLearning({ board, now: () => NOW, collect: false });

  assert.deepEqual(await disabled.invoke(grant), { ok: false, reason: "collect_disabled" });
  assert.deepEqual(await disabled.prepare(context), { kind: "skip", reason: "collect_disabled" });
  assert.deepEqual(await disabled.record(episode()), { ok: false, reason: "collect_disabled" });
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await service.invoke({ ...grant, signal: aborted.signal }), { ok: false, reason: "learning_aborted" });
});

test("unusable prompt grant preserves pending evidence for a later adequate grant", async () => {
  const h = memory();
  await h.service.record(episode());
  assert.deepEqual(await h.service.invoke({ ...grant, budget: { ...grant.budget, maxPromptChars: 0 } }), { ok: false, reason: "prompt_budget_exceeded" });
  assert.equal(h.state().sequence, 1);
  assert.equal((await h.service.invoke(grant)).ok, true);
});

test("legacy absent facts normalize empty; null, malformed and orphan facts reject snapshots", () => {
  const old: BoardState = emptyBoardState();

  assert.deepEqual(normalizeBoardState(old)?.collaborationFacts, []);

  for (const value of [null, {}, [null], [{ ...episode(), schemaVersion: 2 }]]) {
    const raw: unknown = { ...old, collaborationFacts: value };
    assert.equal(normalizeBoardState(raw as BoardState), undefined);
  }

  const orphan: CollaborationOutcome = { schemaVersion: 1, kind: "outcome", factId: "orphan", scope: context.scope,
    recordedAt: NOW, fieldingId: "missing", result: episode().result };

  assert.equal(normalizeBoardState({ ...old, collaborationFacts: [orphan] }), undefined);
});

test("append failure is visible; retry/restart restores exactly one practice and immutable fact identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-collaboration-"));
  let appends = 0;

  try {
    const store = createFileBoardStore(root, { logAppender(file, data, encoding) {
      appends += 1;
      if (appends === 4) throw new Error("injected append failure");
      appendFileSync(file, data, encoding);
    } });
    if (!("apply" in store)) throw new Error(store.reason);

    const service = createCollaborationLearning({ board: store, now: () => NOW });

    assert.equal((await service.record(episode())).ok, true);
    const failed = await service.invoke(grant);

    assert.equal(failed.ok, false);
    await store.close();
    const reopened = createFileBoardStore(root);
    if (!("apply" in reopened)) throw new Error(reopened.reason);

    try {
      const retry = createCollaborationLearning({ board: reopened, now: () => NOW });

      assert.equal((await retry.invoke(grant)).ok, true);
      assert.equal((await retry.prepare(context)).kind, "selected");
      const loaded = await reopened.load();
      assert.equal(loaded.ok, true);

      if (loaded.ok) assert.equal(loaded.state.assets.length, 1);

      assert.equal((await retry.record(episode())).ok, true);
      assert.equal((await retry.record({ ...episode(), assignmentRef: "different" })).ok, false);
    } finally { await reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
