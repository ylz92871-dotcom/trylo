import assert from "node:assert/strict";
import { test } from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import { createCollaborationSubsystemV2 } from "../domain/v2-service.js";
import type { CollaborationBoardPort } from "../domain/contracts.js";
import type { CollaborationAnalysisPortV2, CollaborationEpisodeV2, CollaborationPracticeDraftV2, CollaborationSelectionV2, CollaborationV2Context } from "../domain/v2-contracts.js";
import type { ProviderPort } from "../../../../../ports/provider.js";
import { PROTOCOL_VERSION, type Envelope } from "../../../../../protocol/envelope.js";
import type { CollaborationRound } from "../../../../../subagent/collaboration.js";
import { withCollaborationReporting } from "../../../../../subagent/collaboration-reporting.js";
import { buildSubagentPorts } from "../../../../../surface/cli/wiring-subagent.js";
import { createCollaborationSessionV2 } from "./session-v2.js";
import { createCollaborationTimelineV2 } from "./timeline-v2.js";

const now = () => "2026-11-03T00:00:00.000Z";
const team = { runId: "daily-team", members: ["worker", "reviewer"].map(role => ({ memberId: role, baseRole: role,
  displayName: role, role: { name: role, description: role, model: "inherit", skills: ["selected-skill"], allowedTools: [] } })) };
const context: CollaborationV2Context = { scope: "/workspace", teamRunId: team.runId, taskId: "history", memberId: "worker", role: "worker",
  round: 1, taskFamily: "unknown", dependency: "artifact", coordinationMode: "unknown", difficulty: "unknown",
  members: team.members.map(member => ({ memberId: member.memberId, role: member.baseRole })) };
const round: CollaborationRound = { executionId: "execution-1", teamRunId: team.runId, taskId: "member-task", memberId: "worker", role: "worker",
  round: 1, dependencies: ["history"], assignment: "Inspect supplied specification", handoff: {
    scope: "Inspect conversion spec", artifacts: ["conversion.json"], evidence: ["check:source"], pending: [], blockers: [] } };

function draft(events: readonly string[]): CollaborationPracticeDraftV2 {
  return { familyId: "daily-cooperation", title: "Grounded collaboration trial", hypothesis: "Explicit work and reference sharing may reduce coordination gaps.",
    alternatives: [{ cause: "coordination", explanation: "Handoff information may be incomplete.", evidenceRefs: events },
      { cause: "capability_gap", explanation: "An individual capability gap is also possible; the trace does not settle it.", evidenceRefs: events }],
    discriminator: { observation: "Compare actual execution after a complete handoff.", distinguishes: ["coordination", "capability_gap"] },
    conditions: { dependency: "any", taskFamilies: [], roles: [], coordinationModes: [], difficulty: [], minimumMembers: 2 },
    actions: [{ actionId: "assign", dimension: "assignment", audience: "parent", operation: "assign_member", instruction: "Assign the frozen member a clear scope.", expectedObservable: "A real frozen member dispatch." },
      { actionId: "split", dimension: "decomposition", audience: "parent", operation: "split_task", instruction: "Divide distinct work across the frozen team.", expectedObservable: "At least two actual child task scopes." },
      { actionId: "share", dimension: "information_sharing", audience: "member", operation: "share_reference", instruction: "Send the parent the actual known references.", expectedObservable: "Parent receives explicit references." }],
    failureConditions: ["Current user direction takes precedence."], sourceEventIds: events, sourceEpisodeIds: [], sourceOutcomeIds: [] };
}

function harness(input: { readonly seed?: boolean; readonly signal?: AbortSignal } = {}) {
  let state = emptyBoardState(), calls = 0, enabled = true, boot = 0;
  const warnings: string[] = [];
  const board: CollaborationBoardPort = { load: async () => ({ ok: true, state, generation: 0 }), async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const analyzer: CollaborationAnalysisPortV2 = { async analyze(request) {
    calls += 1;
    const usage = { status: "reported" as const, inputTokens: 1, outputTokens: 1, totalTokens: 2, elapsedMs: 1 };
    return request.window.practices.length === 0 ? { status: "proposed", proposals: [draft(request.window.events.map(event => event.factId))], tokenCost: 2, usage }
      : { status: "no_change", reason: "Wait for independent feedback.", tokenCost: 2, usage };
  } };
  const create = () => createCollaborationSubsystemV2({ board, analyzer, now, enabled: () => enabled, ownerId: `fixture-owner-${++boot}` });
  let subsystem = create();
  const options = () => ({ subsystem, scope: "/workspace", team, turnId: "turn", resolvedModel: "actual-model", requestId: "daily-request",
    grant: { maxSteps: 4, maxModelCalls: 2, maxModelTokens: 16000, maxPromptChars: 1200 }, now, enabled: () => enabled,
    warn: (reason: string) => { warnings.push(reason); }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
  const ready = async () => {
    if (input.seed) {
      await subsystem.observe({ schemaVersion: 2, kind: "event", factId: "history-event", scope: "/workspace", recordedAt: now(), context,
        dimension: "handoff", action: "request_context", summary: "Receiver requested a missing specification before continuing.", source: "runtime", evidenceRefs: ["tool:history"], causedBy: [], metrics: {} });
      await subsystem.observe({ schemaVersion: 2, kind: "episode", factId: "history-episode", scope: "/workspace", recordedAt: now(), context,
        eventIds: ["history-event"], metrics: { delivery: "unverified" }, source: "runtime", evidenceRefs: ["history-event"] });
    }

    const session = createCollaborationSessionV2(options());
    session.start();
    await session.drain();
    return session;
  };

  return { ready, read: () => state, calls: () => calls, warnings, subsystem: () => subsystem,
    disable: () => { enabled = false; }, restart: () => {
      subsystem = create();
      return createCollaborationSessionV2(options());
    } };
}

const toolResult = (id: string): Envelope => ({ protocolVersion: PROTOCOL_VERSION, eventId: `event-${id}`, sequence: 1, producerId: "fixture", producerSequence: 1,
  timestamp: now(), kind: "tool_result", attemptId: "actual-attempt", sessionId: "session", turnId: "turn",
  payload: { toolCallId: id, status: "succeeded" } });

test("local tool-result event ids cannot collide across parent, members, rounds or turns", async () => {
  const h = harness();
  const timeline = createCollaborationTimelineV2({ subsystem: h.subsystem(), scope: "/workspace", team,
    turnId: "turn", requestId: "identity-regression", grant: { maxSteps: 1, maxModelCalls: 0, maxModelTokens: 0, maxPromptChars: 0 },
    now, enabled: () => true, warn: reason => { h.warnings.push(reason); } }, () => {});
  const repeated = toolResult("local-id");

  timeline.capture(repeated);
  timeline.capture(repeated, round);
  timeline.capture(repeated, { ...round, taskId: "sibling-task", memberId: "reviewer", role: "reviewer" });
  timeline.capture(repeated, { ...round, round: 2 });
  timeline.capture({ ...repeated, turnId: "later-turn" });
  await timeline.flush();
  const facts = (h.read().collaborationV2Facts ?? []).filter(fact => fact.kind === "event" && fact.action === "tool_result");

  assert.equal(facts.length, 5, "each actual execution result must retain its own evidence identity");
  assert.equal(new Set(facts.map(fact => fact.factId)).size, 5);
  assert.deepEqual(h.warnings, []);
});

test("parent action adoption is grounded in real member dispatch and receives a later unverified parent outcome", async t => {
  const h = harness({ seed: true }), session = await h.ready();
  t.after(() => session.close());
  const slot = session.attachParent(undefined), delivery = await slot.requestSlot({ turnId: "turn", beat: 1, toolNames: [] });

  assert.ok(delivery);
  if (delivery === undefined) return;

  await slot.recordFielding({ attemptId: "parent-request", turnId: "turn", beat: 1, receipts: delivery.receipts });
  const provider: ProviderPort = { async *stream() {
    yield { type: "text_start", blockId: "a" };
    yield { type: "text_delta", blockId: "a", text: "actual member answer" };
    yield { type: "text_end", blockId: "a" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const tools = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" as const }), cancel: async () => {} };
  const built = buildSubagentPorts({ collaboration: session.member, team, parentTools: tools, workspaceTools: tools, childProvider: provider,
    model: "actual-model", callerMessages: [], permission: { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } } });

  t.after(() => built.runtime.cancelAll());
  const controls = session.wrapParentTools(built.tools);
  const result = await controls.execute({ name: "spawn_agent", toolCallId: "assigned", arguments: {
    message: "Inspect actual scope", agent_type: "worker", member_id: "worker", learning_action_id: "assign" } }, new AbortController().signal);

  assert.equal(result.outcome, "result");
  if (result.outcome !== "result") return;

  await controls.execute({ name: "wait_agent", toolCallId: "observed", arguments: { targets: [result.value.task_id!], timeout_ms: 1000 } }, new AbortController().signal);
  await session.finish({ reason: "completed", usage: { totalTokens: 30 }, usageReported: true });
  await session.drain();
  const facts = h.read().collaborationV2Facts ?? [];
  const adopted = facts.find(fact => fact.kind === "adoption" && fact.actionId === "assign");
  assert.ok(adopted);
  assert.ok(facts.some(fact => fact.kind === "outcome" && adopted !== undefined && fact.adoptionIds.includes(adopted.factId)
    && fact.metrics.delivery === "unverified"));
  const parent = facts.find(fact => fact.kind === "episode" && fact.context.role === "parent");

  assert.equal(parent?.kind === "episode" && parent.metrics.tokenCost, 30);
  assert.ok(parent?.kind === "episode" && parent.evidenceRefs.some(ref => ref.startsWith("cv2-episode:")), "parent episode must reference its member episode");
});

test("merged usage snapshots are not added repeatedly and explicit empty pending/blockers are not scored as missing", async t => {
  const h = harness(), session = await h.ready();
  t.after(() => session.close());
  await session.member.prepare(round, new AbortController().signal);
  await session.member.dispatched(round, "request", undefined);
  await session.member.accountUsage?.(round, { inputTokens: 8, outputTokens: 4, totalTokens: 12 });
  await session.member.accountUsage?.(round, { inputTokens: 8, outputTokens: 4, totalTokens: 12 });
  await session.member.completed(round, "answer");
  await session.drain();
  const second = { ...round, round: 2 };
  await session.member.prepare(second, new AbortController().signal);
  await session.member.dispatched(second, "request-2", undefined);
  await session.member.accountUsage?.(second, { inputTokens: 13, outputTokens: 6, totalTokens: 19 });
  await session.member.completed(second, "follow-up");
  await session.drain();
  const episodes = (h.read().collaborationV2Facts ?? []).filter((fact): fact is CollaborationEpisodeV2 => fact.kind === "episode" && fact.context.role === "worker");

  assert.deepEqual(episodes.map(episode => episode.metrics.tokenCost), [12, 7]);
  assert.ok(episodes.every(episode => episode.metrics.handoffCompleteness === undefined && episode.metrics.delivery === "unverified"));
});

test("task cancellation preserves minimal truthful terminal evidence and stops analysis/adoption", async () => {
  const controller = new AbortController(), h = harness({ signal: controller.signal }), session = await h.ready();

  await session.member.prepare(round, new AbortController().signal);
  await session.member.dispatched(round, "request", undefined);
  controller.abort();
  await session.member.ended(round, "cancelled", "parent_cancelled");
  await session.finish({ reason: "cancelled" });
  await session.close();
  const facts = h.read().collaborationV2Facts ?? [];

  assert.ok(facts.some(fact => fact.kind === "event" && fact.action === "member_terminal" && fact.summary.includes("cancelled")));
  assert.ok(facts.some(fact => fact.kind === "episode" && fact.context.memberId === "worker"));
  assert.equal(facts.filter(fact => fact.kind === "adoption").length, 0);
  assert.equal(h.calls(), 0);
});

test("waiting evidence wakes the daily driver automatically and restart retains the same grant expenditure", async () => {
  const h = harness(), session = await h.ready();
  assert.equal(h.calls(), 0);
  await session.member.prepare(round, new AbortController().signal);
  await session.member.dispatched(round, "request", undefined);
  const reports = withCollaborationReporting({ snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    () => {}, () => 1, value => session.member.report!(round, value));

  await reports.execute({ name: "report_collaboration_observation", toolCallId: "missing-context", arguments: {
    dimension: "handoff", summary: "The supplied source does not identify the input unit; please provide that context before implementation.",
    evidence_refs: [], operation: "request_context" } }, new AbortController().signal);
  await session.member.completed(round, "actual answer");
  await session.drain();
  assert.ok(h.calls() > 0);
  await session.close();
  const before = h.calls();
  const restored = h.restart();
  restored.start();
  await restored.drain();
  assert.equal(h.calls(), before, "restart cannot allocate new model calls for already examined evidence");
  await restored.close();
  assert.equal(new Set((h.read().collaborationV2Facts ?? []).filter(fact => fact.kind === "cycle").map(fact => fact.requestId)).size, 1);
});

test("sharing requires known explicit references and actually includes them in the parent notification", async t => {
  const h = harness({ seed: true }), session = await h.ready();
  t.after(() => session.close());
  const guidance = await session.member.prepare(round, new AbortController().signal);
  assert.ok(guidance);
  await session.member.dispatched(round, "request", guidance);
  await session.member.capture?.(round, toolResult("source-read"));
  const notices: string[] = [];
  const reporting = withCollaborationReporting({ snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    event => { notices.push(event.text ?? ""); }, () => 1, report => session.member.report!(round, report));
  const call = (refs: string[], id: string) => reporting.execute({ name: "report_collaboration_observation", toolCallId: id, arguments: {
    dimension: "information_sharing", summary: "Use the existing inspected source.", evidence_refs: refs,
    operation: "share_reference", learning_action_id: "share" } }, new AbortController().signal);

  assert.equal((await call([], "empty")).outcome, "error");
  assert.equal((await call(["tool:source-read"], "shared")).outcome, "result");
  await session.drain();
  assert.ok(notices[0]?.includes("tool:source-read"));
  assert.equal((h.read().collaborationV2Facts ?? []).filter(fact => fact.kind === "adoption" && fact.actionId === "share").length, 1);
});

test("daily startup resumes a previous team grant before using the current task allowance", async () => {
  const h = harness(), oldGrant = { maxSteps: 2, maxModelCalls: 1, maxModelTokens: 8000, maxPromptChars: 900 };
  const waiting = await h.subsystem().invoke({ subsystem: "collaboration", requestId: "previous-team", scope: context.scope, grant: oldGrant });

  assert.ok(waiting.ok && waiting.phase === "waiting_evidence");
  assert.equal(h.calls(), 0);
  await h.subsystem().observe({ schemaVersion: 2, kind: "event", factId: "previous-request", scope: context.scope, recordedAt: now(),
    context: { ...context, teamRunId: "previous-team-run", taskId: "previous-team-task" },
    dimension: "handoff", action: "request_context", summary: "The receiver requested the missing unit before implementation.", source: "runtime",
    evidenceRefs: ["tool:previous-request"], causedBy: [], metrics: {} });
  const session = h.restart();
  session.start();
  await session.drain();
  const status = await h.subsystem().inspect(context.scope);
  assert.ok(status.ok);

  if (status.ok) {
    const previous = status.cycles.find(cycle => cycle.requestId === "previous-team");
    const current = status.cycles.find(cycle => cycle.requestId === "daily-request");
    assert.ok(previous !== undefined && previous.spent.modelCalls === 1, "the funded older grant must resume without an explicit learn command");
    assert.deepEqual(previous?.grant, oldGrant);
    assert.equal(current?.grant.maxModelTokens, 16000);
    assert.ok((current?.spent.modelCalls ?? 0) <= 2);
  }

  await session.close();
});

test("privacy opt-out and cancellation prevent startup recovery and current allowance admission", async () => {
  for (const mode of ["disabled", "cancelled"] as const) {
    const controller = new AbortController(), h = harness({ signal: controller.signal });

    await h.subsystem().invoke({ subsystem: "collaboration", requestId: "previous-team", scope: context.scope,
      grant: { maxSteps: 2, maxModelCalls: 1, maxModelTokens: 8000, maxPromptChars: 900 } });
    const before = h.read().sequence, cycles = (h.read().collaborationV2Facts ?? []).filter(fact => fact.kind === "cycle");

    if (mode === "disabled") h.disable(); else controller.abort();

    const session = h.restart();
    session.start();
    await session.drain();
    await session.close();
    assert.equal(h.calls(), 0, mode);
    assert.deepEqual((h.read().collaborationV2Facts ?? []).filter(fact => fact.kind === "cycle"), cycles,
      `${mode} must not admit an old or new learning operation`);

    if (mode === "disabled") assert.equal(h.read().sequence, before, "privacy opt-out forbids even terminal evidence");
  }
});

test("an unused frozen team preserves terminal evidence without paying for collaboration analysis", async () => {
  const h = harness(), session = await h.ready();
  await session.finish({ reason: "completed" });
  await session.drain();
  await session.close();
  assert.ok((h.read().collaborationV2Facts ?? []).some(fact => fact.kind === "episode" && fact.context.memberId === "parent"));
  assert.equal(h.calls(), 0, "a parent-only result is not an observed cooperation trajectory");
});

for (const audience of ["parent", "member"] as const) test(`privacy withdrawal during ${audience} preparation discards late advice`, async t => {
  const h = harness({ seed: true }), seed = await h.ready();
  t.after(() => seed.close());
    let enabled = true, release!: () => void, entered!: () => void, captured: CollaborationSelectionV2 | undefined;
    const deferred = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const base = h.subsystem(), subsystem = { ...base, async prepareActions(...args: Parameters<typeof base.prepareActions>) {
      const value = await base.prepareActions(...args);
      captured = value;
      entered();
      await deferred;
      return value;
    } };
    const session = createCollaborationSessionV2({ subsystem, scope: context.scope, team, turnId: "turn", requestId: "privacy-test",
      grant: { maxSteps: 4, maxModelCalls: 2, maxModelTokens: 16000, maxPromptChars: 1200 }, now, enabled: () => enabled, warn: () => {} });
    const existing = { message: { role: "system" as const, content: "Existing method advice." }, receipts: [] };
    const slot = session.attachParent({ intentOn: () => false, requestSlot: async () => existing, observe: async () => {},
      recordFielding: async () => {}, recordFeedback: async () => {}, endTurn: async () => {} });
    const pending = audience === "parent" ? slot.requestSlot({ turnId: "turn", beat: 1, toolNames: [] })
      : session.member.prepare(round, new AbortController().signal);

    await ready;
  enabled = false;
  release();
    assert.equal(captured?.kind, "selected", "the delayed port must have real advice, so this tests the integration fence");
    const result = await pending;

    if (audience === "parent") assert.deepEqual(result, existing, "existing method ownership and content are preserved");
    else assert.equal(result, undefined, "late member guidance must be discarded");

    await session.close();
});

test("missing usage evidence leaves context cost unknown while later independent rounds retain their actual delta", async t => {
  const h = harness({ seed: true }), seed = await h.ready();
  t.after(() => seed.close());
  const base = h.subsystem();
  let rejectUsage = true;
  const subsystem = { ...base, async observe(fact: Parameters<typeof base.observe>[0]) {
    if (fact.kind === "event" && fact.action === "execution_usage" && rejectUsage) {
      rejectUsage = false;
      return { ok: false as const, reason: "board_unavailable" };
    }
    return base.observe(fact);
  } };
  const session = createCollaborationSessionV2({ subsystem, scope: context.scope, team, turnId: "turn", requestId: "usage-failure",
    grant: { maxSteps: 4, maxModelCalls: 2, maxModelTokens: 16000, maxPromptChars: 1200 }, now, enabled: () => true, warn: () => {} });

  t.after(() => session.close());
  const guidance = await session.member.prepare(round, new AbortController().signal);

  await session.member.dispatched(round, "request", guidance);
  await session.member.capture?.(round, toolResult("usage-source"));
  const reporting = withCollaborationReporting({ snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    () => {}, () => 1, report => session.member.report!(round, report));

  assert.equal((await reporting.execute({ name: "report_collaboration_observation", toolCallId: "shared-usage-source", arguments: {
    dimension: "information_sharing", summary: "The inspected reference is available.", evidence_refs: ["tool:usage-source"],
    operation: "share_reference", learning_action_id: "share" } }, new AbortController().signal)).outcome, "result");
  await session.member.accountUsage?.(round, { inputTokens: 8, outputTokens: 4, totalTokens: 12 });
  await session.member.accountUsage?.(round, { inputTokens: 13, outputTokens: 6, totalTokens: 19 });
  await session.member.completed(round, "actual output");
  await session.drain();
  const firstFacts = h.read().collaborationV2Facts ?? [];
  const episode = firstFacts.find(fact => fact.kind === "episode" && fact.context.taskId === round.taskId && fact.context.round === 1);

  assert.ok(episode?.kind === "episode");
  if (episode?.kind !== "episode") return;

  const outcome = firstFacts.find(fact => fact.kind === "outcome" && fact.episodeIds.includes(episode.factId));

  assert.ok(outcome?.kind === "outcome");
  if (outcome?.kind !== "outcome") return;

  for (const fact of [episode, outcome]) {
    assert.equal(Object.hasOwn(fact.metrics, "tokenCost"), false, "a partial cost must remain unknown, not become 0 or 7");
    assert.ok(fact.evidenceRefs.includes("runtime:usage_evidence_incomplete"));
  }

  const delta = firstFacts.find(fact => fact.kind === "event" && fact.action === "execution_usage" && fact.context.taskId === round.taskId);

  assert.ok(delta?.kind === "event");
  if (delta?.kind !== "event") return;

  assert.equal(delta.metrics.tokenCost, 7);
  assert.ok(delta.summary.includes("delta cannot establish complete context cost"));
  const second = { ...round, round: 2 }, nextGuidance = await session.member.prepare(second, new AbortController().signal);

  await session.member.dispatched(second, "request-2", nextGuidance);
  await session.member.accountUsage?.(second, { inputTokens: 17, outputTokens: 8, totalTokens: 25 });
  await session.member.completed(second, "later output");
  await session.drain();
  const next = h.read().collaborationV2Facts?.find(fact => fact.kind === "episode" && fact.context.taskId === round.taskId && fact.context.round === 2);

  assert.equal(next?.kind === "episode" && next.metrics.tokenCost, 6);
});
