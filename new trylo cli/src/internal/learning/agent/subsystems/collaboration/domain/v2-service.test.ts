import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore } from "../../../../../adapters/learning-store/file-event-store.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState, normalizeBoardState } from "../../../../control/state.js";
import type { CollaborationBoardPort } from "./contracts.js";
import type { CollaborationAnalysisPortV2, CollaborationEventV2, CollaborationPracticeDraftV2, CollaborationSelectionV2,
  CollaborationV2Context } from "./v2-contracts.js";
import { authorityChangeRequested } from "./v2-admissibility.js";
import { ACTION_DIMENSIONS } from "./v2-parse.js";
import type { CollaborationActionV2, CollaborationDimension } from "./v2-contracts.js";
import { createCollaborationSubsystemV2 as createSubsystem } from "./v2-service.js";
import { hydrateCollaborationArchiveV2 } from "./v2-hydration.js";

const NOW = "2026-11-03T00:00:00.000Z";
let ownerSequence = 0;
const createCollaborationSubsystemV2 = (options: Parameters<typeof createSubsystem>[0]) => createSubsystem({ ownerId: `test-owner-${++ownerSequence}`, ...options });
const context: CollaborationV2Context = { scope: "workspace:v2", teamRunId: "team", taskId: "worker-task", round: 1,
  memberId: "worker", role: "worker", taskFamily: "mapping", dependency: "artifact", coordinationMode: "sequential", difficulty: "unknown",
  members: [{ memberId: "worker", role: "worker", model: "frozen-model", capabilityRefs: ["config:skills"] }, { memberId: "reviewer", role: "reviewer" }], taskConditionRefs: ["input:task"] };
const invocation = { subsystem: "collaboration" as const, requestId: "daily-allowance", scope: context.scope,
  grant: { maxSteps: 4, maxModelCalls: 4, maxModelTokens: 20000, maxPromptChars: 3000 } };

function event(id = "event1", source: CollaborationEventV2["source"] = "runtime"): CollaborationEventV2 {
  return { schemaVersion: 2, kind: "event", factId: id, scope: context.scope, recordedAt: NOW, context, dimension: "handoff",
    action: "request_context", summary: "The receiver requested the missing acceptance reference before doing dependent work.",
    source, evidenceRefs: ["runtime:delivered-message"], causedBy: [], metrics: { waitMs: 250 } };
}

function draft(window: Parameters<CollaborationAnalysisPortV2["analyze"]>[0]["window"]): CollaborationPracticeDraftV2 {
  const parent = window.practices.at(-1);
  const refs = window.events.map(e => e.factId);

  return { familyId: "dependent-acceptance-context", title: "Request the producer's acceptance reference", hypothesis: "Missing acceptance context may cause coordination rework.",
    alternatives: [{ cause: "coordination", explanation: "A missing shared reference may explain the observed wait.", evidenceRefs: refs },
      { cause: "task_difficulty", explanation: "The transformation itself may be difficult; a complete-context comparison is still needed.", evidenceRefs: refs }],
    discriminator: { observation: "Compare independently checked results after sharing the same acceptance reference.", distinguishes: ["coordination", "task_difficulty"] },
    conditions: { dependency: "artifact", taskFamilies: ["mapping"], roles: [], coordinationModes: [], difficulty: [], minimumMembers: 2 },
    actions: [{ actionId: "ask-for-context", dimension: "handoff", operation: "request_context", audience: "member",
      instruction: "Before dependent work, request the producer's missing acceptance reference.", expectedObservable: "The producer receives an actual context request." }],
    failureConditions: ["The receiver already has complete acceptance context."], sourceEventIds: refs,
    sourceEpisodeIds: window.episodes.map(e => e.factId), sourceOutcomeIds: window.outcomes.map(e => e.factId),
    ...(parent === undefined ? {} : { parentVersionId: parent.versionId }) };
}

function memory() {
  let state = emptyBoardState();
  const board: CollaborationBoardPort = { load: async () => ({ ok: true, state, generation: 0 }), async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  return { board, state: () => state };
}

function analyst() {
  let calls = 0;
  const analyzer: CollaborationAnalysisPortV2 = { async analyze({ window }) { calls += 1;
  return { status: "proposed", proposals: [draft(window)],
    tokenCost: 50, usage: { status: "reported", totalTokens: 50, inputTokens: 35, outputTokens: 15, elapsedMs: 5, model: "analysis-model" } }; } };
  return { analyzer, calls: () => calls };
}

async function selected(service: ReturnType<typeof createCollaborationSubsystemV2>): Promise<Extract<CollaborationSelectionV2, { kind: "selected" }>> {
  const selection = await service.prepareActions(context, "member", 3000);
  assert.equal(selection.kind, "selected");
  return selection;
}

test("daily waiting wakes on real evidence with the same grant; own ledger facts never cause a paid analysis", async () => {
  const h = memory(), model = analyst(), service = createCollaborationSubsystemV2({ ...h, analyzer: model.analyzer, now: () => NOW });

  assert.equal((await service.invoke(invocation)).ok, true);
  assert.equal(model.calls(), 0);
  await service.observe({ ...event("roster"), dimension: "assignment", action: "team_started", evidenceRefs: [], metrics: {} });
  await service.invoke(invocation);
  assert.equal(model.calls(), 0);
  assert.equal((await service.observe(event())).ok, true);
  const result = await service.invoke(invocation);
  assert.ok(result.ok);

  if (result.ok) {
    assert.equal(result.newVersionIds.length, 1);
    assert.equal(result.spent.modelCalls, 1);
    assert.equal(result.spent.modelTokens, 50);
  }

  assert.equal(model.calls(), 1);
  assert.deepEqual(h.state().activations, []);
  await service.invoke(invocation);
  await service.resumePending({ scope: context.scope });
  assert.equal(model.calls(), 1);
  const selection = await selected(service);
  assert.match(selection.guidance, /learning_action_id=ask-for-context/);
  assert.equal((await service.prepareActions({ ...context, dependency: "independent" }, "member", 3000)).kind, "skip");
  assert.equal((await service.prepareActions({ ...context, taskFamily: "other" }, "member", 3000)).kind, "skip");
});

test("assignment noise preserves quota until a correlated parent result includes its member's actual timeline", async () => {
  const h = memory();
  let calls = 0;
  let correlated = false;
  const model: CollaborationAnalysisPortV2 = { async analyze({ window }) { calls += 1;
    correlated = window.episodes.some(e => e.factId === "member-result") && window.events.some(e => e.factId === "assigned");
    return { status: "no_change", reason: "uncertain causal difference", tokenCost: 50, usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } };
  } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW });

  await service.observe({ ...event("assigned"), dimension: "assignment", action: "assign_member", metrics: {} });
  await service.invoke(invocation);
  assert.equal(calls, 0);
  await service.observe({ schemaVersion: 2, kind: "episode", factId: "member-result", scope: context.scope, recordedAt: NOW, context,
    eventIds: ["assigned"], metrics: { delivery: "unverified" }, source: "runtime", evidenceRefs: ["actual:output"] });
  await service.invoke(invocation);
  assert.equal(calls, 0);
  await service.observe({ schemaVersion: 2, kind: "episode", factId: "parent-result", scope: context.scope, recordedAt: NOW,
    context: { ...context, memberId: "parent", role: "parent" }, eventIds: ["assigned"], metrics: { delivery: "unverified" },
    source: "runtime", evidenceRefs: ["member-result"] });
  await service.invoke(invocation);
  assert.equal(calls, 1);
  assert.equal(correlated, true);
});

test("a parent and two completed member timelines can exceed thirty-two events without blocking continuous learning", async () => {
  const h = memory();
  let calls = 0;
  const model: CollaborationAnalysisPortV2 = { async analyze({ window }) {
    calls += 1;
    if (calls === 1) {
      assert.equal(window.episodes.length, 3);
      assert.ok(window.events.length <= 64);
    }
    return { status: "no_change", reason: "The retained team evidence supports no change yet.", tokenCost: 50,
      usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } };
  } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW });
  const memberEpisodes: string[] = [];

  for (const memberId of ["worker", "reviewer"]) {
    const memberContext = { ...context, memberId, role: memberId, taskId: `${memberId}-task` };
    const eventIds: string[] = [];

    for (let index = 0; index < 20; index += 1) {
      const id = `${memberId}-tool-${index}`;
      eventIds.push(id);
      await service.observe({ ...event(id), context: memberContext, dimension: "assignment", action: "tool_result", metrics: {} });
    }

    const factId = `${memberId}-finished`;
    memberEpisodes.push(factId);
    await service.observe({ schemaVersion: 2, kind: "episode", factId, scope: context.scope, recordedAt: NOW,
      context: memberContext, eventIds, source: "runtime", metrics: { delivery: "unverified" }, evidenceRefs: eventIds });
  }

  const parentContext = { ...context, memberId: "parent", role: "parent", taskId: "parent-task" };

  await service.observe({ ...event("parent-terminal"), context: parentContext, dimension: "review", action: "team_terminal", metrics: {} });
  await service.observe({ schemaVersion: 2, kind: "episode", factId: "correlated-team-result", scope: context.scope, recordedAt: NOW,
    context: parentContext, eventIds: ["parent-terminal"], source: "runtime", metrics: { delivery: "unverified" }, evidenceRefs: memberEpisodes });
  assert.equal((await service.invoke(invocation)).ok, true);
  assert.equal(calls, 1);
  await service.observe(event("next-real-context-request"));
  assert.equal((await service.invoke(invocation)).ok, true);
  assert.equal(calls, 2, "a large earlier team episode must not permanently block later experience");
  assert.equal(h.state().collaborationV2Facts?.filter(f => f.kind === "event").length, 42, "raw evidence stays in the Board");
});

test("a parent-only answer in an unused frozen team does not spend collaboration allowance", async () => {
  const h = memory(), model = analyst(), service = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, now: () => NOW });

  await service.observe({ ...event("parent-start"), context: { ...context, memberId: "parent", role: "parent" }, action: "parent_started", dimension: "assignment", metrics: {} });
  await service.observe({ schemaVersion: 2, kind: "episode", factId: "parent-only", scope: context.scope, recordedAt: NOW,
    context: { ...context, memberId: "parent", role: "parent" }, eventIds: ["parent-start"], metrics: { delivery: "unverified" }, source: "runtime", evidenceRefs: [] });
  await service.observe({ schemaVersion: 2, kind: "outcome", factId: "parent-neutral-result", scope: context.scope, recordedAt: NOW,
    adoptionIds: [], episodeIds: ["parent-only"], metrics: { delivery: "unverified" }, source: "runtime", evidenceRefs: [] });
  const result = await service.invoke(invocation);
  assert.ok(result.ok);
  assert.equal(model.calls(), 0);

  if (result.ok) assert.equal(result.spent.modelCalls, 0);
});

test("a grounded peer issue includes its actual runtime causes without acquiring external quality authority", async () => {
  const h = memory();
  let sawCause = false;
  const model: CollaborationAnalysisPortV2 = { async analyze({ window }) { sawCause = window.events.some(e => e.factId === "member-start")
    && window.events.some(e => e.factId === "peer-issue");
  return { status: "proposed", proposals: [{ ...draft(window), sourceEventIds: ["peer-issue"] }],
    tokenCost: 50, usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } }; } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW });

  await service.observe({ ...event("member-start"), action: "member_started", metrics: {} });
  await service.observe({ ...event("peer-issue", "peer_report"), causedBy: ["member-start"] });
  assert.equal((await service.invoke(invocation)).ok, true);
  assert.equal(sawCause, true);
  await selected(service);
  assert.deepEqual(h.state().activations, []);
});

test("large archives and pending batches shrink to the estimator's allowance; an oversized single subject remains unpaid and pending", async () => {
  const h = memory();
  let family = 0;
  const seed: CollaborationAnalysisPortV2 = { async analyze({ window }) { const { parentVersionId: _parent, ...p } = draft(window);
    family += 1;
  return { status: "proposed", proposals: [{ ...p, familyId: `archive-${family}`, title: `Archived distinct issue ${family}`,
      actions: p.actions.map(a => ({ ...a, instruction: `Observed issue ${family}: ${"share the exact acceptance reference. ".repeat(15)}` })) }],
    tokenCost: 50, usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } }; } };
  const seedService = createCollaborationSubsystemV2({ board: h.board, analyzer: seed, now: () => NOW });

  for (let index = 0; index < 12; index += 1) { await seedService.observe(event(`archive-event-${index}`));
    assert.equal((await seedService.invoke({ ...invocation, requestId: `archive-${index}`, grant: { ...invocation.grant, maxSteps: 1, maxModelCalls: 1 } })).ok, true); }

  let calls = 0;
  let shrunk = false;
  const estimate = (window: Parameters<CollaborationAnalysisPortV2["analyze"]>[0]["window"]) => Math.ceil(JSON.stringify(window).length / 2) + 1600;
  const model: CollaborationAnalysisPortV2 = { estimateInputTokens: estimate, async analyze({ window, maxTokens }) {
    calls += 1;
    assert.ok(estimate(window) + 1024 <= maxTokens);
    assert.ok(window.practices.length <= 2);
    shrunk ||= window.events.length < 12;
    return { status: "no_change", reason: "bounded comparison only", tokenCost: 50,
      usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } };
  } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW });

  for (let index = 0; index < 12; index += 1) await service.observe({ ...event(`long-event-${index}`), summary: "actual cooperation evidence ".repeat(45) });

  const result = await service.invoke({ ...invocation, requestId: "bounded-materials", grant: { ...invocation.grant, maxModelTokens: 16000 } });

  assert.ok(result.ok);
  assert.ok(calls > 0 && calls <= 4);
  assert.equal(shrunk, true);
  const tooLarge = createCollaborationSubsystemV2({ board: h.board, now: () => NOW, analyzer: { estimateInputTokens: () => Infinity,
    analyze: async () => { throw new Error("oversized material must not issue a model request"); } } });

  await tooLarge.observe(event("oversized-new-subject"));
  const deferred = await tooLarge.invoke({ ...invocation, requestId: "too-large" });
  assert.ok(deferred.ok);

  if (deferred.ok) {
    assert.equal(deferred.reason, "input_budget_insufficient");
    assert.equal(deferred.spent.modelCalls, 0);
  }
});

test("prompt exposure and peer claims cannot become adoption; actual operation receipts enable feedback and immutable refinement", async () => {
  const h = memory(), model = analyst(), service = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, now: () => NOW });

  await service.observe(event());
  await service.invoke(invocation);
  const selection = await selected(service);
  const base = { schemaVersion: 2 as const, scope: context.scope, recordedAt: NOW };

  assert.equal((await service.recordReceipt({ ...base, kind: "exposure", factId: "shown", context, selectionId: selection.selectionId,
    versionId: selection.versionId, actionIds: [selection.actions[0]!.actionId], audience: "member", requestId: "actual-response", contentHash: selection.contentHash })).ok, true);
  await service.observe(event("peer-claim", "peer_report"));
  const adoption = { ...base, kind: "adoption" as const, factId: "adopted", exposureId: "shown", actionId: "ask-for-context", eventIds: ["peer-claim"] };

  assert.equal((await service.recordReceipt(adoption)).ok, false);
  await service.observe(event("actual-action"));
  assert.equal((await service.recordReceipt({ ...adoption, eventIds: ["actual-action"] })).ok, true);
  assert.equal((await service.observe({ ...base, kind: "outcome", factId: "checked-negative", adoptionIds: ["adopted"], episodeIds: [],
    metrics: { delivery: "failed", reworkCount: 1 }, source: "peer_report", evidenceRefs: ["peer:claim"] })).ok, false);
  assert.equal((await service.observe({ ...base, kind: "outcome", factId: "checked-negative", adoptionIds: ["adopted"], episodeIds: [],
    metrics: { delivery: "failed", reworkCount: 1 }, source: "external_checker", evidenceRefs: ["checker:actual-failure"] })).ok, true);
  assert.deepEqual(await service.prepareActions(context, "member", 3000), { kind: "skip", reason: "negative_outcome" });
  const learned = await service.invoke(invocation);
  assert.ok(learned.ok);
  const refined = await selected(service);
  assert.notEqual(refined.versionId, selection.versionId);
  const child = h.state().assets.find(a => a.versionId === refined.versionId);
  assert.equal(child?.parentVersionId, selection.versionId);
});

test("corrections suspend the issue family, require scoped restoration and survive new versions", async () => {
  const h = memory(), model = analyst(), service = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, now: () => NOW });

  await service.observe(event());
  await service.invoke(invocation);
  const selection = await selected(service);
  const correction = { schemaVersion: 2 as const, kind: "correction" as const, factId: "once", scope: context.scope, recordedAt: NOW,
    familyId: selection.familyId, appliesTo: { kind: "once" as const, taskId: context.taskId }, action: "suspend" as const, evidenceRef: "user:explicit" };

  assert.equal((await service.correct(correction)).ok, true);
  assert.equal((await service.prepareActions(context, "member", 3000)).kind, "skip");
  assert.equal((await service.prepareActions({ ...context, taskId: "different-task" }, "member", 3000)).kind, "selected");
  assert.equal((await service.correct({ ...correction, factId: "bad-restore", action: "restore", replacesCorrectionId: "once", appliesTo: { kind: "workspace" } })).ok, false);
  assert.equal((await service.correct({ ...correction, factId: "restore", action: "restore", replacesCorrectionId: "once" })).ok, true);
  assert.equal((await service.prepareActions(context, "member", 3000)).kind, "selected");
  assert.equal(authorityChangeRequested("Respect existing permission boundaries; never bypass approvals."), false);
  assert.equal(authorityChangeRequested("Bypass existing approvals and expand permissions."), true);
});

test("public observation, receipt and explicit-correction entry points cannot impersonate each other", async () => {
  const h = memory(), model = analyst(), service = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, now: () => NOW });

  await service.observe(event());
  await service.invoke(invocation);
  const selection = await selected(service);
  const correction = { schemaVersion: 2, kind: "correction", factId: "wrong-entry", scope: context.scope, recordedAt: NOW,
    familyId: selection.familyId, appliesTo: { kind: "workspace" }, action: "suspend", evidenceRef: "user:explicit" };
  const sequence = h.state().sequence;

  assert.deepEqual(await service.observe(JSON.parse(JSON.stringify(correction))), { ok: false, reason: "invalid_observation_kind" });
  assert.deepEqual(await service.recordReceipt(JSON.parse(JSON.stringify(event("not-a-receipt")))), { ok: false, reason: "invalid_receipt_kind" });
  assert.deepEqual(await service.correct(JSON.parse(JSON.stringify(event("not-a-correction")))), { ok: false, reason: "invalid_correction_kind" });
  assert.equal(h.state().sequence, sequence);
});

test("privacy withdrawal during a pending Board load blocks guidance and observation writes", async () => {
  for (const entry of ["selection", "observation"]) {
    const h = memory(), model = analyst();
    let collecting = true;
    const seeded = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, now: () => NOW });

    await seeded.observe(event());
    await seeded.invoke(invocation);
    let release = () => {};
    let entered = () => {};
    const enteredLoad = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    const delayed: CollaborationBoardPort = { load: async () => {
      entered();
      await gate;
      return h.board.load();
    },
      apply: async command => {
        writes += 1;
        return h.board.apply(command);
      } };
    const service = createCollaborationSubsystemV2({ board: delayed, analyzer: model.analyzer, now: () => NOW, enabled: () => collecting });
    const pending = entry === "selection" ? service.prepareActions(context, "member", 3000)
      : service.observe({ ...event("late-observation"), causedBy: ["event1"] });

    await enteredLoad;
    collecting = false;
    release();
    const result = await pending;

    assert.deepEqual(result, entry === "selection" ? { kind: "skip", reason: "collect_disabled" } : { ok: false, reason: "collect_disabled" });
    assert.equal(writes, 0);
  }
});

test("privacy withdrawal during archived body lookup prevents restoring the hot projection", async () => {
  const h = memory();
  let collecting = true;
  let writes = 0;
  let release = () => {};
  let entered = () => {};
  const enteredRead = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const archived: CollaborationBoardPort = { load: async () => ({ ok: true, generation: 0,
    state: { ...h.state(), collaborationV2Archives: [{ schemaVersion: 1, scope: context.scope, throughSequence: 1, totalFactCount: 1,
      archivedFactCount: 1, learningCursor: 0, archiveDigest: "canonical-digest", recordedAt: NOW,
      usage: { modelCalls: 0, chargedTokens: 0, reportedTokens: 0, reportedCalls: 0 } }] } }),
    readArchive: async () => {
      entered();
      await gate;
      return { ok: true, records: [{ type: "record_collaboration_v2", commandId: "collaboration-v2:event1", issuedAt: NOW, fact: event() }] };
    },
    apply: async command => {
      writes += 1;
      return h.board.apply(command);
    } };
  const pending = hydrateCollaborationArchiveV2({ board: archived, now: () => NOW, query: { scope: context.scope, factIds: ["event1"] }, canContinue: () => collecting });

  await enteredRead;
  collecting = false;
  release();
  assert.deepEqual(await pending, { ok: false, reason: "collect_disabled" });
  assert.equal(writes, 0);
});

test("paid generation requires an injected boot owner and zero quota remains a no-IO path", async () => {
  const board: CollaborationBoardPort = { load: async () => { throw new Error("unexpected IO"); }, apply: async () => { throw new Error("unexpected IO"); } };
  const service = createSubsystem({ board, analyzer: analyst().analyzer, now: () => NOW });
  assert.deepEqual(await service.invoke(invocation), { ok: false, reason: "claim_owner_required" });
  const idle = await service.invoke({ ...invocation, grant: { ...invocation.grant, maxModelTokens: 0 } });
  assert.ok(idle.ok);
  if (idle.ok) assert.equal(idle.phase, "idle");
});

test("concurrent factories cannot repeat the same reserved model call", async () => {
  const h = memory(), model = analyst();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocking: CollaborationAnalysisPortV2 = { async analyze(request) {
    await gate;
    return model.analyzer.analyze(request);
  } };
  const a = createCollaborationSubsystemV2({ board: h.board, analyzer: blocking, now: () => NOW, ownerId: "A" });
  const b = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, now: () => NOW, ownerId: "A" });

  await a.observe(event());
  const first = a.invoke(invocation);

  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

  const concurrent = await b.invoke(invocation);
  assert.equal(concurrent.ok, false);

  if (!concurrent.ok) assert.equal(concurrent.reason, "cycle_claim_active");

  assert.equal(model.calls(), 0);
  release();
  assert.equal((await first).ok, true);
  assert.equal(model.calls(), 1);
  await b.invoke(invocation);
  assert.equal(model.calls(), 1);
});

test("all eight cooperation dimensions use the same generated action contract for parent or member consumption", async () => {
  for (const [operation, dimension] of Object.entries(ACTION_DIMENSIONS)) {
    const h = memory();
    const audience = ["split_task", "assign_member", "schedule_review"].includes(operation) ? "parent" as const : "member" as const;
    const model: CollaborationAnalysisPortV2 = { async analyze({ window }) {
      const base = draft(window);
      return { status: "proposed", tokenCost: 50, proposals: [{ ...base,
        actions: [{ ...base.actions[0]!, dimension: dimension as CollaborationDimension,
          operation: operation as CollaborationActionV2["operation"], audience, instruction: `Apply the observed ${operation} improvement within the existing assigned scope.` }] }],
      usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } };
    } };
    const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW });

    await service.observe({ ...event(), dimension: dimension as CollaborationDimension, action: operation });
    await service.observe({ schemaVersion: 2, kind: "episode", factId: "team-finished", scope: context.scope, recordedAt: NOW,
      context: { ...context, memberId: "parent", role: "parent" }, eventIds: ["event1"], metrics: { delivery: "unverified" }, source: "runtime", evidenceRefs: [] });
    assert.equal((await service.invoke(invocation)).ok, true);
    const target = audience === "parent" ? { ...context, memberId: "parent", role: "parent" } : context;
    const selection = await service.prepareActions(target, audience, 3000);
    assert.equal(selection.kind, "selected");

    if (selection.kind === "selected") assert.equal(selection.actions[0]?.operation, operation);
  }
});

test("a new owner waits for a crashed unknown claim to expire, preserves its charge and fences a late old response", async () => {
  const h = memory(), model = analyst();
  let clock = NOW;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const old = createCollaborationSubsystemV2({ board: h.board, ownerId: "old", claimLeaseMs: 1000, now: () => clock,
    analyzer: { async analyze(request) {
      await gate;
      return model.analyzer.analyze(request);
    } } });
  const restarted = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, ownerId: "new", now: () => clock });

  await old.observe(event());
  const oldAttempt = old.invoke(invocation);

  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

  assert.equal((await restarted.resumePending({ scope: context.scope })).ok, false);
  assert.equal(model.calls(), 0);
  clock = "2026-11-03T00:00:02.000Z";
  const recovered = await restarted.resumePending({ scope: context.scope });
  assert.ok(recovered.ok);

  if (recovered.ok) {
    assert.equal(recovered.spent.modelCalls, 2);
    assert.equal(recovered.spent.modelTokens, 8192 + 50);
  }

  assert.equal(model.calls(), 1);
  release();
  assert.equal((await oldAttempt).ok, false);
  assert.equal(h.state().assets.length, 1);
});

test("an expired-claim recovery cannot discard a response saved after its stale read", async () => {
  const h = memory(), model = analyst();
  let clock = NOW;
  let releaseResponse = () => {}, releaseAdmission = () => {}, releaseRecovery = () => {};
  let recoveryEntered = () => {}, analysisSaved = () => {};
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
  const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
  const atRecovery = new Promise<void>(resolve => { recoveryEntered = resolve; });
  const atSavedAnalysis = new Promise<void>(resolve => { analysisSaved = resolve; });
  const oldBoard: CollaborationBoardPort = { load: h.board.load, async apply(command) {
    const result = await h.board.apply(command);
    if (command.type === "record_collaboration_v2" && command.fact.kind === "analysis") {
      analysisSaved();
      await admissionGate;
    }
    return result;
  } };
  const newBoard: CollaborationBoardPort = { load: h.board.load, async apply(command) {
    if (command.type === "record_collaboration_v2" && command.fact.kind === "cycle" && command.fact.reason === "recovered_unknown_outcome") {
      recoveryEntered();
      await recoveryGate;
    }
    return h.board.apply(command);
  } };
  const old = createCollaborationSubsystemV2({ board: oldBoard, ownerId: "old", claimLeaseMs: 1000, now: () => clock,
    analyzer: { async analyze(request) {
      await responseGate;
      return model.analyzer.analyze(request);
    } } });
  const restarted = createCollaborationSubsystemV2({ board: newBoard, analyzer: model.analyzer, ownerId: "new", now: () => clock });

  await old.observe(event());
  const first = old.invoke(invocation);

  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

  clock = "2026-11-03T00:00:02.000Z";
  const recovery = restarted.resumePending({ scope: context.scope });
  await atRecovery;
  releaseResponse();
  await atSavedAnalysis;
  releaseRecovery();

  try {
    const stale = await recovery;
    assert.equal(stale.ok, false);
    assert.equal(model.calls(), 1);
    if (!stale.ok) assert.equal(stale.reason, "collaboration_reference_invalid");
  } finally {
    releaseAdmission();
    await first;
  }

  assert.equal((await restarted.resumePending({ scope: context.scope })).ok, true);
  assert.equal(model.calls(), 1);
  assert.equal(h.state().assets.length, 1);
});

test("saved analysis resumes partial asset admission after restart without another paid call", async () => {
  for (const interruptedCommand of ["commit_asset", "start_evaluation"]) {
  const h = memory(), model = analyst();
  let fail = true;
  const faulty: CollaborationBoardPort = { load: h.board.load, async apply(command) {
    if (command.type === interruptedCommand && fail) {
      fail = false;
      throw new Error("injected storage interruption");
    }
    return h.board.apply(command);
  } };
  const first = createCollaborationSubsystemV2({ board: faulty, analyzer: model.analyzer, now: () => NOW, ownerId: "old-process" });

  await first.observe(event());
  assert.equal((await first.invoke(invocation)).ok, false);
  assert.equal(model.calls(), 1);
  const restarted = createCollaborationSubsystemV2({ board: h.board, analyzer: model.analyzer, now: () => NOW, ownerId: "new-process" });
  const recovered = await restarted.resumePending({ scope: context.scope });
  assert.equal(recovered.ok, true);
  assert.equal(model.calls(), 1);
  assert.equal(h.state().assets.length, 1);
  assert.equal((await selected(restarted)).actions.length, 1);
  }
});

test("cancelled analysis retains an unknown reservation; completed or cancelled cycles do not mint quota", async () => {
  const h = memory();
  const controller = new AbortController();
  let calls = 0;
  const analyzer: CollaborationAnalysisPortV2 = { async analyze() {
    calls += 1;
    controller.abort();
    return { status: "failed", reason: "cancelled", tokenCost: 8192 };
  } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer, now: () => NOW });

  await service.observe(event());
  const cancelled = await service.invoke({ ...invocation, signal: controller.signal });
  assert.ok(cancelled.ok);

  if (cancelled.ok) {
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.spent.modelTokens, 8192);
  }

  await service.invoke(invocation);
  assert.equal(calls, 1);
  assert.equal((await service.invoke({ ...invocation, grant: { ...invocation.grant, maxModelTokens: 99999 } })).ok, false);
});

test("cancellation or privacy withdrawal after a successful model response cannot persist its proposal or admit assets", async () => {
  for (const revoke of ["cancel", "privacy"]) {
    const h = memory(), controller = new AbortController();
    let collecting = true;
    const model: CollaborationAnalysisPortV2 = { async analyze({ window }) {
      if (revoke === "cancel") controller.abort();else collecting = false;
      return { status: "proposed", proposals: [draft(window)], tokenCost: 50,
        usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } };
    } };
    const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW, enabled: () => collecting });

    await service.observe(event());
    const result = await service.invoke({ ...invocation, signal: controller.signal });
    assert.ok(result.ok);

    if (result.ok) {
      assert.equal(result.phase, "cancelled");
      assert.equal(result.spent.modelTokens, 50);
    }

    assert.equal(h.state().assets.length, 0);
    assert.equal(h.state().proposals.length, 0);
    assert.equal(h.state().collaborationV2Facts?.some(f => f.kind === "analysis"), false);
  }
});

test("a known model overrun after cancellation or privacy withdrawal remains body-free and preserves actual cost", async () => {
  for (const revoke of ["cancel", "privacy"]) {
    const h = memory(), controller = new AbortController();
    let collecting = true;
    const actualTokens = invocation.grant.maxModelTokens + 50;
    const model: CollaborationAnalysisPortV2 = { async analyze({ window }) {
      if (revoke === "cancel") controller.abort();else collecting = false;
      return { status: "proposed", proposals: [draft(window)], tokenCost: actualTokens,
        usage: { status: "reported", totalTokens: actualTokens, elapsedMs: 1 } };
    } };
    const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW, enabled: () => collecting });

    await service.observe(event());
    const result = await service.invoke({ ...invocation, signal: controller.signal });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.reason, "model_token_overrun");
      assert.equal(result.spent?.modelTokens, actualTokens);
    }

    const head = h.state().collaborationV2Facts?.filter(f => f.kind === "cycle").at(-1);

    assert.equal(head?.kind === "cycle" ? head.phase : undefined, "failed");
    assert.equal(head?.kind === "cycle" ? head.spent.modelTokens : undefined, actualTokens);
    assert.equal(h.state().assets.length, 0);
    assert.equal(h.state().proposals.length, 0);
    assert.equal(h.state().collaborationV2Facts?.some(f => f.kind === "analysis"), false);
  }
});

test("an invalid candidate settles its charged step and can learn from later facts without a new grant", async () => {
  const h = memory();
  let calls = 0;
  const model: CollaborationAnalysisPortV2 = { async analyze({ window }) {
    calls += 1;
    const proposed = draft(window);
    return { status: "proposed", proposals: [calls === 1 ? { ...proposed, sourceEventIds: ["fabricated-reference"] } : proposed], tokenCost: 50,
      usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } };
  } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW });

  await service.observe(event());
  assert.equal((await service.invoke(invocation)).ok, false);
  assert.equal(calls, 1);
  await service.invoke(invocation);
  assert.equal(calls, 1, "rejected response cannot remain a stuck reserved step");
  await service.observe(event("new-context"));
  assert.equal((await service.invoke(invocation)).ok, true);
  assert.equal(calls, 2);
  await selected(service);
});

test("a transient learning-provider failure retries only within the original persisted allowance", async () => {
  const h = memory();
  let calls = 0;
  const model: CollaborationAnalysisPortV2 = { async analyze({ window }) {
    calls += 1;
    return calls === 1 ? { status: "failed", reason: "before_headers", tokenCost: 0,
      usage: { status: "reported", totalTokens: 0, elapsedMs: 1 } } : { status: "proposed", proposals: [draft(window)], tokenCost: 50,
      usage: { status: "reported", totalTokens: 50, elapsedMs: 1 } };
  } };
  const service = createCollaborationSubsystemV2({ board: h.board, analyzer: model, now: () => NOW });

  await service.observe(event());
  const result = await service.invoke(invocation);
  assert.ok(result.ok);

  if (result.ok) {
    assert.equal(result.spent.modelCalls, 2);
    assert.equal(result.spent.modelTokens, 50);
  }

  assert.equal(calls, 2);
  await service.invoke(invocation);
  assert.equal(calls, 2);
  await selected(service);
});

test("V2 Board log and snapshot survive reopening; old absent fields default empty and malformed V2 state fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-collaboration-v2-"));
  const model = analyst();

  try {
    const store = createFileBoardStore(root);
    if (!("apply" in store)) throw new Error(store.reason);

    const first = createCollaborationSubsystemV2({ board: store, analyzer: model.analyzer, now: () => NOW });

    await first.observe(event());
    assert.equal((await first.invoke(invocation)).ok, true);
    const loaded = await store.load();
    assert.ok(loaded.ok);
    if (loaded.ok) assert.ok((await store.snapshot(loaded.generation)).ok);

    await store.close();
    const reopened = createFileBoardStore(root);
    if (!("apply" in reopened)) throw new Error(reopened.reason);

    try {
      const second = createCollaborationSubsystemV2({ board: reopened, analyzer: model.analyzer, now: () => NOW });
      assert.equal((await second.invoke(invocation)).ok, true);
      assert.equal(model.calls(), 1);
      await selected(second);
    } finally { await reopened.close(); }

    assert.deepEqual(normalizeBoardState(emptyBoardState())?.collaborationV2Facts, []);
    assert.equal(normalizeBoardState({ ...emptyBoardState(), collaborationV2Facts: JSON.parse("null") }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
