import type { Envelope } from "../../../../../protocol/envelope.js";
import { isSelectedPromptBudgetObservation } from "../../../../../protocol/prompt-budget-observation.js";
import type { CollaborationRound } from "../../../../../subagent/collaboration.js";
import type { SubagentTeam } from "../../../../../subagent/team.js";
import { contentHashOf } from "../../../../control/hash.js";
import { objectiveEventDetails, type ObjectiveEventDetails } from "./objective-event-details.js";
import { objectiveRoundContext } from "./objective-round-context.js";
import { objectiveMemberReport, type ObjectiveMemberReport } from "./objective-member-report.js";

type Identity = {
  readonly executionId: string; readonly taskId: string; readonly memberId: string;
  readonly teamRunId?: string; readonly round?: number;
};

type Source = { readonly eventId: string; readonly turnId?: string; readonly sessionId?: string;
  readonly producerId: string; readonly producerSequence: number; readonly sourceRef: string };

export type CollaborationObjectiveFact = Identity & ObjectiveEventDetails & Partial<ObjectiveMemberReport> & {
  readonly kind: "round_prepared" | "round_dispatched" | "round_completed" | "round_ended" | "tool_pending" | "tool_unreturned_at_boundary" | "tool_result" | "file_write" | "observation" | "terminal" | "member_report";
  readonly sourceRef: string; readonly source?: Source; readonly requestId?: string;
  readonly toolCallId?: string; readonly toolName?: string; readonly status?: string; readonly errorCode?: string;
  readonly boundary?: "round_completed" | "round_ended";
  readonly resolvedFromBoundary?: "round_completed" | "round_ended"; readonly relatedSourceRef?: string;
};

type RoundObservation = { readonly identity: Identity; readonly originalAssignment: string; readonly assignment: string;
  readonly phase: "prepared" | "dispatched" | "completed" | "ended"; readonly handoff?: CollaborationRound["handoff"] };

type PendingTool = CollaborationObjectiveFact & { readonly kind: "tool_pending" };

type UnreturnedTool = CollaborationObjectiveFact & { readonly kind: "tool_unreturned_at_boundary"; readonly boundary: "round_completed" | "round_ended" };

export type CollaborationObjectiveOptions = {
  readonly scope: string; readonly turnId: string; readonly taskId: string; readonly team?: SubagentTeam;
  readonly goal?: string; readonly maxFacts?: number; readonly maxPendingTools?: number; readonly maxUnreturnedTools?: number;
};

const row = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
const cap = (value: number | undefined, fallback: number, max: number) => Number.isSafeInteger(value) ? Math.max(1, Math.min(max, value!)) : fallback;
const excerpt = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
const ROUND_PHASE_ORDER = { prepared: 0, dispatched: 1, completed: 2, ended: 3 } as const;
const DECISION_BOUNDARIES: ReadonlySet<CollaborationObjectiveFact["kind"]> = new Set([
  "round_prepared", "round_dispatched", "round_completed", "round_ended", "member_report",
]);

/** Ephemeral, bounded projection of execution-owned facts. No verdict, learning write, scheduling or permission authority. */
export function createCollaborationObjectiveObservations(options: CollaborationObjectiveOptions) {
  const maxFacts = cap(options.maxFacts, 24, 64), maxPendingTools = cap(options.maxPendingTools, 16, 32);
  const maxUnreturnedTools = cap(options.maxUnreturnedTools, 16, 32);
  const facts = new Map<string, CollaborationObjectiveFact>(), rounds = new Map<string, RoundObservation>();
  const pending = new Map<string, PendingTool>(), finishedTools = new Map<string, true>(), seen = new Map<string, true>();
  const unreturned = new Map<string, UnreturnedTool>();
  const rawExecutions = new Set<string>();
  const recordedFactRefs = new Map<string, true>();
  let omittedFacts = 0, omittedTools = 0, omittedMembers = 0, omittedUnreturned = 0, omittedInvalidToolObservations = 0, memberRevision = 0;
  const goalFor = (value: string) => ({ excerpt: excerpt(value, 1000), contentHash: contentHashOf(value), truncated: value.length > 1000 });
  let goal = options.goal === undefined ? undefined : goalFor(options.goal);
  const memberKey = (identity: { readonly teamRunId?: string; readonly memberId: string }) => contentHashOf([identity.teamRunId, identity.memberId]);
  const ownIdentity = (round: CollaborationRound): Identity => ({ executionId: round.executionId ?? round.taskId,
    taskId: round.taskId, memberId: round.memberId, teamRunId: round.teamRunId, round: round.round });
  const addFact = (fact: CollaborationObjectiveFact) => {
    if (recordedFactRefs.has(fact.sourceRef)) return;

    recordedFactRefs.set(fact.sourceRef, true);

    if (recordedFactRefs.size > 256) recordedFactRefs.delete(recordedFactRefs.keys().next().value!);

    // Routine tool traffic is advisory observation. Fencing every call/result would starve PA decisions while a team is busy.
    if (fact.memberId !== "personal_agent" && DECISION_BOUNDARIES.has(fact.kind)) memberRevision += 1;

    facts.set(fact.sourceRef, fact);

    if (facts.size > maxFacts) {
      facts.delete(facts.keys().next().value!);
      omittedFacts += 1;
    }
  };
  const rememberRound = (round: CollaborationRound, phase: RoundObservation["phase"]) => {
    const key = memberKey(round), previous = rounds.get(key);
    if (!previous && rounds.size >= 64) {
      omittedMembers += 1;
      return false;
    }

    const identity = ownIdentity(round);

    if (previous) {
      const sameRound = previous.identity.executionId === identity.executionId && previous.identity.taskId === identity.taskId && previous.identity.round === identity.round;

      if (previous.identity.executionId === identity.executionId && previous.phase === "ended") return false;

      // A new prepare boundary admits the next incarnation; a late callback cannot overwrite its state.
      if (phase !== "prepared" && !sameRound) return false;

      if (sameRound && ROUND_PHASE_ORDER[phase] < ROUND_PHASE_ORDER[previous.phase]) return false;

      if (previous.identity.executionId === identity.executionId && previous.identity.taskId === round.taskId
        && (previous.identity.round ?? 0) > round.round) return false;
    }

    rounds.set(key, { identity: ownIdentity(round), originalAssignment: previous?.identity.taskId === round.taskId
      ? previous.originalAssignment : excerpt(round.assignment, 1000),
      assignment: excerpt(round.assignment, 1000), phase, ...(round.handoff === undefined ? {} : { handoff: structuredClone(round.handoff) }) });

    return true;
  };
  const roundFact = (round: CollaborationRound, kind: CollaborationObjectiveFact["kind"], requestId?: string) => {
    const identity = ownIdentity(round);
    addFact({ ...identity, kind, sourceRef: `collaboration-boundary:${contentHashOf([identity, kind, requestId])}`,
      ...(requestId === undefined ? {} : { requestId }) });
  };
  const sourceFor = (event: Envelope): Source => ({ eventId: event.eventId, producerId: event.producerId,
    producerSequence: event.producerSequence, ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    sourceRef: `execution-event:${contentHashOf([event.producerId, event.sessionId, event.turnId, event.attemptId, event.eventId, event.producerSequence])}` });
  const parentIdentity = (): Identity => ({ executionId: options.turnId, taskId: options.taskId, memberId: "personal_agent",
    ...(options.team === undefined ? {} : { teamRunId: options.team.runId }) });
  const eventIdentity = (event: Envelope, round?: CollaborationRound): Identity | undefined => {
    if (round) return options.team !== undefined && (round.teamRunId !== options.team.runId
      || !options.team.members.some(member => member.memberId === round.memberId)) ? undefined : ownIdentity(round);

    if (event.turnId !== options.turnId) return undefined;

    if (!event.kind.startsWith("subagent_")) return parentIdentity();

    const payload = event.payload;
    if (!text(payload.subagentId) || !text(payload.taskId) || !text(payload.memberId)
      || options.team !== undefined && (payload.teamRunId !== options.team.runId || !options.team.members.some(member => member.memberId === payload.memberId))) return undefined;

    return { executionId: payload.subagentId, taskId: payload.taskId, memberId: payload.memberId,
      ...(text(payload.teamRunId) ? { teamRunId: payload.teamRunId } : {}),
      ...(typeof payload.round === "number" && Number.isSafeInteger(payload.round) && payload.round > 0 ? { round: payload.round } : {}) };
  };
  const unreturnedAtBoundary = (identity: Identity, boundary: UnreturnedTool["boundary"], status?: string) => {
    const matches = (tool: CollaborationObjectiveFact) => tool.executionId === identity.executionId && tool.taskId === identity.taskId
      && (boundary === "round_ended" || tool.round === identity.round);
    const selected = [...[...pending].filter(([, tool]) => matches(tool)),
      ...(boundary === "round_ended" ? [...unreturned].filter(([, tool]) => matches(tool)) : [])];

    for (const [key, tool] of selected) {
      pending.delete(key);
      const fact: UnreturnedTool = { ...tool, kind: "tool_unreturned_at_boundary", boundary,
        ...(status === undefined ? {} : { status }), relatedSourceRef: tool.relatedSourceRef ?? tool.sourceRef,
        sourceRef: `collaboration-tool-boundary:${contentHashOf([key, boundary, status])}` };

      // This queue records missing results at an observed boundary, never failure or confirmed resource retirement.
      unreturned.delete(key);
      unreturned.set(key, fact);
      addFact(fact);

      if (unreturned.size > maxUnreturnedTools) {
        unreturned.delete(unreturned.keys().next().value!);
        omittedUnreturned += 1;
      }
    }
  };
  const toolEvent = (identity: Identity, source: Source, id: string, name: string | undefined, status?: string, errorCode?: string) => {
    const key = contentHashOf([identity.executionId, identity.taskId, identity.round, id]);

    if (status === undefined) {
      if (pending.has(key) || unreturned.has(key) || finishedTools.has(key)) return;
      if (pending.size >= maxPendingTools) {
        omittedTools += 1;
        return;
      }
      const fact: PendingTool = { ...identity, kind: "tool_pending", toolCallId: id,
        ...(name === undefined ? {} : { toolName: name }), sourceRef: source.sourceRef, source };
      pending.set(key, fact);
      addFact(fact);
      return;
    }

    const opened = pending.get(key) ?? unreturned.get(key);
    pending.delete(key);
    unreturned.delete(key);

    if (finishedTools.has(key)) return;

    finishedTools.set(key, true);

    if (finishedTools.size > 128) finishedTools.delete(finishedTools.keys().next().value!);

    const resolvedName = name ?? opened?.toolName;

    addFact({ ...identity, kind: "tool_result", toolCallId: id,
      ...(resolvedName === undefined ? {} : { toolName: resolvedName }), status,
      ...(opened?.kind !== "tool_unreturned_at_boundary" ? {} : { resolvedFromBoundary: opened.boundary, relatedSourceRef: opened.sourceRef }),
      ...(errorCode === undefined ? {} : { errorCode }), sourceRef: source.sourceRef, source });
  };

  return {
    observeGoal(value: string) { goal = goalFor(value); },
    /** Parent inspection tools can observe themselves without invalidating their own CAS token. */
    decisionRevision: () => memberRevision,
    capture(event: Envelope, round?: CollaborationRound): void {
      if (isSelectedPromptBudgetObservation(event)) return;

      const identity = eventIdentity(event, round);
      if (!identity) return;

      if (round !== undefined) {
        rawExecutions.add(identity.executionId);
        if (rawExecutions.size > 128) rawExecutions.delete(rawExecutions.values().next().value!);
      }

      const source = sourceFor(event);
      if (seen.has(source.sourceRef)) return;

      seen.set(source.sourceRef, true);
      if (seen.size > 256) seen.delete(seen.keys().next().value!);

      const payload = event.payload;

      if (event.kind === "tool_use" || event.kind === "tool_result") {
        if (!text(payload.toolCallId)) {
          omittedInvalidToolObservations += 1;
          return;
        }
        toolEvent(identity, source, payload.toolCallId, text(payload.name) ? payload.name : undefined,
          event.kind === "tool_result" ? text(payload.status) ? payload.status : "result_observed" : undefined,
          text(payload.code) ? payload.code : undefined);
        return;
      }

      if (event.kind === "file_write" || event.kind === "observation" || event.kind === "terminal") {
        const details = objectiveEventDetails(event.kind, payload);
        if (details !== undefined) addFact({ ...identity, ...details, kind: event.kind, sourceRef: source.sourceRef, source });
        return;
      }

      if (event.kind !== "subagent_update") return;

      const report = objectiveMemberReport(payload.observation);
      if (report !== undefined) {
        addFact({ ...identity, kind: "member_report", sourceRef: source.sourceRef, source, ...report });
        return;
      }

      // Activity summaries have no work-round coordinate. The mounted raw hook is stronger evidence;
      // a delayed summary must not close a same-named tool from a later round.
      if (rawExecutions.has(identity.executionId) || !row(payload.activity)) return;

      const activity = payload.activity;
      if (activity.kind !== "tool" && activity.kind !== "result") return;

      if (!text(activity.id)) {
        omittedInvalidToolObservations += 1;
        return;
      }

      toolEvent(identity, source, activity.id, text(activity.tool) ? activity.tool : undefined,
        activity.kind === "result" ? activity.ok === true ? "succeeded" : "not_succeeded" : undefined);
    },
    roundPrepared(round: CollaborationRound) { if (rememberRound(round, "prepared")) roundFact(round, "round_prepared"); },
    roundDispatched(round: CollaborationRound, requestId: string) { if (rememberRound(round, "dispatched")) roundFact(round, "round_dispatched", requestId); },
    roundCompleted(round: CollaborationRound) {
      if (!rememberRound(round, "completed")) return;
      roundFact(round, "round_completed");
      unreturnedAtBoundary(ownIdentity(round), "round_completed");
    },
    roundEnded(identity: Pick<CollaborationRound, "teamRunId" | "taskId" | "memberId" | "round" | "executionId">, status: string, errorCode?: string) {
      const key = memberKey(identity), previous = rounds.get(key);
      if (!previous || previous.identity.taskId !== identity.taskId || previous.identity.round !== identity.round
        || identity.executionId !== undefined && identity.executionId !== previous.identity.executionId) return;

      rounds.set(key, { ...previous, phase: "ended" });
      unreturnedAtBoundary(previous.identity, "round_ended", status);
      addFact({ ...previous.identity, kind: "round_ended", status, ...(errorCode === undefined ? {} : { errorCode }),
        sourceRef: `collaboration-boundary:${contentHashOf([previous.identity, "round_ended", status, errorCode])}` });
    },
    roundContext(round: CollaborationRound, input: { readonly configuredToolNames?: readonly string[]; readonly maxChars?: number } = {}): string {
      const previous = rounds.get(memberKey(round));
      return objectiveRoundContext(round, { ...(goal === undefined ? {} : { goal: goal.excerpt }),
        ...(previous === undefined ? {} : { originalAssignment: previous.originalAssignment }),
        ...(input.configuredToolNames === undefined ? {} : { configuredToolNames: input.configuredToolNames }),
        pendingTools: [...pending.values()].filter(tool => tool.executionId === (round.executionId ?? round.taskId)),
        maxChars: cap(input.maxChars, 900, 900) });
    },
    recentFacts(): readonly CollaborationObjectiveFact[] {
      // The request view carries current unresolved calls. A historical call-start must not look pending after its result.
      const latest = [...facts.values()].filter(fact => fact.kind !== "tool_pending");
      return structuredClone([...latest, ...pending.values()]);
    },
    inspectionView(maxBytes = 8192) {
      const byteLimit = Number.isSafeInteger(maxBytes) ? Math.max(2048, Math.min(24000, maxBytes)) : 8192;
      const latestRounds = [...rounds.values()].reverse(), latestFacts = [...facts.values()].filter(fact => fact.kind !== "tool_pending").reverse();
      const roundRows: unknown[] = [], factRows: CollaborationObjectiveFact[] = [], pendingRows: CollaborationObjectiveFact[] = [], unreturnedRows: UnreturnedTool[] = [];
      const view = { schema: "collaboration-objective-view/v1" as const, scope: options.scope, taskId: options.taskId,
        ...(goal === undefined ? { goal: "unknown" } : { goal: { ...goal, excerpt: excerpt(goal.excerpt, 300), truncated: goal.truncated || goal.excerpt.length > 300 } }),
        totals: { members: rounds.size, recentFacts: latestFacts.length, pendingTools: pending.size, unreturnedTools: unreturned.size }, rounds: roundRows,
        pendingTools: pendingRows, unreturnedTools: unreturnedRows, recentFacts: factRows,
        omitted: { rounds: rounds.size, recentFacts: latestFacts.length, pendingTools: pending.size, unreturnedTools: unreturned.size,
          historicalFacts: omittedFacts, pendingToolObservations: omittedTools, historicalUnreturnedTools: omittedUnreturned, members: omittedMembers,
          invalidToolObservations: omittedInvalidToolObservations },
        note: "Observed data only. Missing results are not failures or proof of resource cleanup; configured tools and handoffs grant no authority or quality acceptance." };
      const add = <T>(target: T[], value: T) => {
        target.push(value);
        if (new TextEncoder().encode(JSON.stringify(view)).length <= byteLimit - 128) return;
        target.pop();
      };

      for (const tool of [...pending.values()].slice(0, 16)) add(pendingRows, tool);

      for (const value of latestRounds.slice(0, 8)) {
        const handoff = value.handoff, artifacts = handoff?.artifacts.slice(0, 2).filter(ref => ref.length <= 512) ?? [];
        add(roundRows, { identity: value.identity, phase: value.phase, assignment: excerpt(value.assignment, 200),
          originalAssignment: excerpt(value.originalAssignment, 200), assignmentTruncated: value.assignment.length > 200 || value.originalAssignment.length > 200,
          ...(handoff === undefined ? { handoff: "absent" } : { handoff: { scope: excerpt(handoff.scope, 120),
            artifactCount: handoff.artifacts.length, artifacts, omittedArtifactRefs: handoff.artifacts.length - artifacts.length,
            evidenceCount: handoff.evidence.length, pendingCount: handoff.pending.length, blockerCount: handoff.blockers.length,
            pending: handoff.pending.slice(0, 2).map(item => excerpt(item, 120)), blockers: handoff.blockers.slice(0, 2).map(item => excerpt(item, 120)),
            textTruncated: handoff.scope.length > 120 || handoff.pending.length > 2 || handoff.blockers.length > 2
              || [...handoff.pending, ...handoff.blockers].some(item => item.length > 120) } }) });
      }

      for (const tool of [...unreturned.values()].reverse().slice(0, 16)) add(unreturnedRows, tool);

      for (const fact of latestFacts.slice(0, 8)) add(factRows, fact);

      view.omitted.rounds -= roundRows.length;
      view.omitted.recentFacts -= factRows.length;
      view.omitted.pendingTools -= pendingRows.length;
      view.omitted.unreturnedTools -= unreturnedRows.length;

      return structuredClone(view);
    },
    snapshot() { return structuredClone({ schema: "collaboration-objective-observations/v1" as const, scope: options.scope, turnId: options.turnId,
      taskId: options.taskId, goalAvailable: goal !== undefined, ...(goal === undefined ? {} : { goal }), rounds: [...rounds.values()], pendingTools: [...pending.values()],
      unreturnedTools: [...unreturned.values()], recentFacts: [...facts.values()],
      omitted: { facts: omittedFacts, pendingToolObservations: omittedTools, unreturnedTools: omittedUnreturned, members: omittedMembers,
        invalidToolObservations: omittedInvalidToolObservations },
      note: "A tool without an observed result is unresolved evidence, not failure or proof of resource cleanup. Round completion and supplied handoffs are not quality acceptance." }); },
  };
}

export type CollaborationObjectiveObservations = ReturnType<typeof createCollaborationObjectiveObservations>;
