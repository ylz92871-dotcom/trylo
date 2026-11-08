import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore } from "../../../../../adapters/learning-store/file-event-store.js";
import { readCollaborationV2Archive } from "../../../../../adapters/learning-store/collaboration-archive.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { CollaborationBoardPort } from "./contracts.js";
import type { CollaborationAnalysisPortV2, CollaborationEventV2, CollaborationPracticeDraftV2, CollaborationV2Context } from "./v2-contracts.js";
import { createCollaborationSubsystemV2 } from "./v2-service.js";
import { hydrateCollaborationArchiveV2 } from "./v2-hydration.js";
import { collaborationUsageTotalsV2 } from "./v2-retention.js";

const NOW = "2026-11-03T00:00:00.000Z";
const context: CollaborationV2Context = { scope: "retention-workspace", teamRunId: "team", taskId: "task", memberId: "worker", role: "worker",
  round: 1, taskFamily: "contract", dependency: "artifact", coordinationMode: "sequential", difficulty: "unknown",
  members: [{ memberId: "worker", role: "worker" }, { memberId: "reviewer", role: "reviewer" }] };
const request = { subsystem: "collaboration" as const, requestId: "learn-old", scope: context.scope,
  grant: { maxSteps: 1, maxModelCalls: 1, maxModelTokens: 16000, maxPromptChars: 3000 } };

function event(id: string, noise = false, scope = context.scope): CollaborationEventV2 {
  return { schemaVersion: 2, kind: "event", factId: id, scope, recordedAt: NOW, context: { ...context, scope },
    dimension: noise ? "assignment" : "handoff", action: noise ? "member_started" : "request_context", summary: "Actual bounded runtime observation",
    source: "runtime", evidenceRefs: noise ? [] : ["runtime:message"], causedBy: [], metrics: {} };
}

function proposal(eventIds: readonly string[]): CollaborationPracticeDraftV2 {
  return { familyId: "shared-contract", title: "Share the missing contract", hypothesis: "Missing handoff context may explain repeated investigation.",
    alternatives: [{ cause: "coordination", explanation: "The producer may have omitted a reference.", evidenceRefs: eventIds },
      { cause: "task_difficulty", explanation: "The task itself may still be difficult.", evidenceRefs: eventIds }],
    discriminator: { observation: "Check the same receiver after sharing complete context.", distinguishes: ["coordination", "task_difficulty"] },
    conditions: { dependency: "artifact", taskFamilies: ["contract"], roles: [], coordinationModes: [], difficulty: [], minimumMembers: 2 },
    actions: [{ actionId: "ask", dimension: "handoff", operation: "request_context", audience: "member", instruction: "Request the missing contract before dependent work.", expectedObservable: "An actual request reaches the producer." }],
    failureConditions: ["The receiver already has the contract."], sourceEventIds: eventIds, sourceEpisodeIds: [], sourceOutcomeIds: [] };
}

function memory() {
  let state = emptyBoardState();
  let archives = 0;
  const board: CollaborationBoardPort = { load: async () => ({ ok: true, state, generation: 0 }), async apply(command) {
    const result = reduce(state, command);
    if (result.ok) {
      state = result.state;
      archives += result.events.filter(e => e.type === "collaboration_v2_compacted").length;
    }
    return result;
  } };
  return { board, state: () => state, archiveEvents: () => archives };
}

async function compact(store: Pick<BoardStore, "load" | "apply">, id: string) {
  const loaded = await store.load();
  assert.ok(loaded.ok);
  if (!loaded.ok) throw new Error("Board unavailable");
  return store.apply({ type: "compact_collaboration_v2", commandId: id, issuedAt: NOW, scope: context.scope, expectedSequence: loaded.state.sequence });
}

test("automatic hot compaction passes twenty thousand facts across sub-threshold workspaces without a permanent global stop", async () => {
  const h = memory();

  for (let index = 0; index < 21050; index += 1) {
    const scope = `workspace-${Math.floor(index / 1000)}`;
    const fact = event(`telemetry-${index}`, true, scope);
    const result = await h.board.apply({ type: "record_collaboration_v2", commandId: `collaboration-v2:${fact.factId}`, issuedAt: NOW, fact });
    assert.equal(result.ok, true, `fact ${index} must not hit a permanent history capacity`);
  }

  assert.ok(h.archiveEvents() > 0);
  assert.ok((h.state().collaborationV2Facts?.length ?? 0) < 8192);
  assert.ok((h.state().collaborationV2Archives?.length ?? 0) > 0);
  assert.equal(h.state().appliedCommands.filter(c => c.commandId.startsWith("collaboration-v2:")).length, 21050);
});

test("reservation settlement across an archive watermark preserves exact charged and reported usage", async () => {
  const h = memory();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const analyzer: CollaborationAnalysisPortV2 = { async analyze() { await gate;
  return { status: "no_change", reason: "not enough causal evidence", tokenCost: 40,
    usage: { status: "reported", totalTokens: 40, inputTokens: 30, outputTokens: 10, elapsedMs: 1 } }; } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer, now: () => NOW, ownerId: "reservation-owner" });

  await service.observe(event("source"));
  const running = service.invoke(request);

  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

  for (let index = 0; index < 170; index += 1) await service.observe(event(`noise-${index}`, true));

  assert.equal((await compact(h.board, "compact-reservation")).ok, true);
  assert.deepEqual(collaborationUsageTotalsV2(h.state(), context.scope), { modelCalls: 1, chargedTokens: 8192, reportedTokens: 0, reportedCalls: 0 });
  release();
  assert.equal((await running).ok, true);
  assert.equal((await compact(h.board, "compact-settled")).ok, true);
  assert.deepEqual(collaborationUsageTotalsV2(h.state(), context.scope), { modelCalls: 1, chargedTokens: 40, reportedTokens: 40, reportedCalls: 1 });
});

test("the same Board log rehydrates frozen late-feedback receipts and closed quota without losing corrections or double-counting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-collaboration-archive-"));
  let calls = 0;
  let opened: BoardStore | undefined;
  const analyzer: CollaborationAnalysisPortV2 = { async analyze({ window }) { calls += 1;
  return calls === 1
    ? { status: "proposed", proposals: [proposal(window.events.map(e => e.factId))], tokenCost: 40, usage: { status: "reported", totalTokens: 40, elapsedMs: 1 } }
    : { status: "no_change", reason: "await independent feedback", tokenCost: 40, usage: { status: "reported", totalTokens: 40, elapsedMs: 1 } }; } };

  try {
    const store = createFileBoardStore(root);
    if (!("apply" in store)) throw new Error(store.reason);

    opened = store;
    const board: CollaborationBoardPort = { load: () => store.load(), apply: command => store.apply(command), readArchive: query => readCollaborationV2Archive(root, query) };
    const service = createCollaborationSubsystemV2({ board, analyzer, now: () => NOW, ownerId: "first-owner" });

    await service.observe(event("source"));
    assert.equal((await service.invoke(request)).ok, true);
    const selection = await service.prepareActions(context, "member", 3000);
    assert.equal(selection.kind, "selected");

    if (selection.kind !== "selected") throw new Error("missing selected practice");

    const base = { schemaVersion: 2 as const, scope: context.scope, recordedAt: NOW };

    assert.equal((await service.recordReceipt({ ...base, kind: "exposure", factId: "old-exposure", context, selectionId: selection.selectionId,
      versionId: selection.versionId, actionIds: ["ask"], audience: "member", requestId: "response", contentHash: selection.contentHash })).ok, true);
    await service.observe(event("actual-request"));
    await service.recordReceipt({ ...base, kind: "adoption", factId: "old-adoption", exposureId: "old-exposure", actionId: "ask", eventIds: ["actual-request"] });
    await service.observe({ ...base, kind: "episode", factId: "old-episode", context, eventIds: ["actual-request"], metrics: { delivery: "unverified" }, source: "runtime", evidenceRefs: [] });
    await service.observe({ ...base, kind: "outcome", factId: "frozen-runtime-outcome", adoptionIds: ["old-adoption"], episodeIds: ["old-episode"], metrics: { delivery: "unverified" }, source: "runtime", evidenceRefs: [] });
    const closed = { ...request, requestId: "old-closed-no-change" };

    assert.equal((await service.invoke(closed)).ok, true);
    assert.equal(calls, 2);
    await service.correct({ ...base, kind: "correction", factId: "once-correction", familyId: selection.familyId,
      appliesTo: { kind: "once", taskId: "exception" }, action: "suspend", evidenceRef: "user:explicit" });

    for (let index = 0; index < 170; index += 1) await service.observe(event(`old-noise-${index}`, true));

    const first = await compact(store, "compact-before-restart");
    assert.ok(first.ok);

    if (!first.ok) throw new Error("Compaction failed");

    assert.ok(!first.state.collaborationV2Facts?.some(f => f.factId === "old-episode"));
    assert.ok(first.events.some(e => e.type === "collaboration_v2_compacted" && e.archivedFacts.some(f => f.factId === "old-episode")));
    const firstTotal = first.state.collaborationV2Archives?.find(a => a.scope === context.scope)?.totalFactCount;

    assert.deepEqual(collaborationUsageTotalsV2(first.state, context.scope), { modelCalls: 2, chargedTokens: 80, reportedTokens: 80, reportedCalls: 2 });
    const loaded = await store.load();
    assert.ok(loaded.ok);

    if (loaded.ok) { const destructive = await store.compact(loaded.generation);
    assert.equal(destructive.ok, false);
      if (!destructive.ok) assert.equal(destructive.reason, "collaboration_archive_preservation_required");
    assert.equal((await store.snapshot(loaded.generation)).ok, true); }

    await store.close();
    opened = undefined;
    const reopened = createFileBoardStore(root);
    if (!("apply" in reopened)) throw new Error(reopened.reason);

    opened = reopened;

    try {
      const reopenedBoard: CollaborationBoardPort = { load: () => reopened.load(), apply: c => reopened.apply(c), readArchive: q => readCollaborationV2Archive(root, q) };
      const resumed = createCollaborationSubsystemV2({ board: reopenedBoard, analyzer, now: () => NOW, ownerId: "next-owner" });
      const replayed = await resumed.invoke(closed);
      assert.ok(replayed.ok);

      if (replayed.ok) {
        assert.equal(replayed.phase, "completed");
        assert.equal(replayed.spent.modelCalls, 1);
        assert.equal(replayed.spent.modelTokens, 40);
      }

      assert.equal(calls, 2, "archived closed grants cannot be minted again");
      assert.equal((await resumed.invoke({ ...closed, grant: { ...closed.grant, maxModelTokens: 99999 } })).ok, false);
      const originals = await readCollaborationV2Archive(root, { scope: context.scope, factIds: ["old-episode"] });
      assert.ok(originals.ok);

      if (originals.ok) {
        const tampered = originals.records.map(r => r.fact.factId === "actual-request" && r.fact.kind === "event"
          ? { ...r, fact: { ...r.fact, summary: "Forged archived observation" } } : r);
        const forged = await reopened.apply({ type: "rehydrate_collaboration_v2", commandId: "forged-archive", issuedAt: NOW, scope: context.scope, records: tampered });
        assert.equal(forged.ok, false);
        if (!forged.ok) assert.equal(forged.reason, "command_payload_conflict");
      }

      const historical = await hydrateCollaborationArchiveV2({ board: reopenedBoard, now: () => NOW, query: { scope: context.scope, factIds: ["old-episode"] } });

      assert.ok(historical.ok);
      if (!historical.ok) throw new Error("Archive hydration failed");

      assert.ok(historical.state.collaborationV2Facts?.some(f => f.factId === "old-adoption"));
      assert.ok(historical.state.collaborationV2Facts?.some(f => f.factId === "old-exposure"));
      assert.equal((await resumed.prepareActions({ ...context, taskId: "exception" }, "member", 3000)).kind, "skip");
      assert.equal((await resumed.observe({ ...base, kind: "outcome", factId: "late-checker", adoptionIds: ["old-adoption"], episodeIds: ["old-episode"],
        metrics: { delivery: "failed", reworkCount: 1 }, source: "external_checker", evidenceRefs: ["checker:actual"] })).ok, true);

      for (let index = 0; index < 170; index += 1) await resumed.observe(event(`new-noise-${index}`, true));

      const second = await compact(reopened, "compact-after-late-feedback");
      assert.ok(second.ok);

      if (second.ok) { assert.deepEqual(collaborationUsageTotalsV2(second.state, context.scope), { modelCalls: 2, chargedTokens: 80, reportedTokens: 80, reportedCalls: 2 });
        assert.equal(second.state.collaborationV2Archives?.find(a => a.scope === context.scope)?.totalFactCount, firstTotal! + 171); }

      assert.deepEqual(await resumed.prepareActions(context, "member", 3000), { kind: "skip", reason: "negative_outcome" });
    } finally {
      await reopened.close();
      opened = undefined;
    }
  } finally {
    await opened?.close();
    await rm(root, { recursive: true, force: true });
  }
});
