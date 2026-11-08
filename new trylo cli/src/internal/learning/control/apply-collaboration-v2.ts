import type { BoardCommand } from "./commands.js";
import type { BoardState } from "./state.js";
import { fail, nextSeq, succeed, type ReduceResult } from "./result.js";
import { contentHashOf } from "./hash.js";
import type { CollaborationCycleV2, CollaborationV2Fact } from "../domains/collaboration/v2-contracts.js";
import { isCollaborationPracticeV2, isCollaborationV2Fact } from "../domains/collaboration/v2-parse.js";
import { selectCollaborationActionsV2 } from "../domains/collaboration/v2-policy.js";
import { cycleTransitionValid } from "../domains/collaboration/v2-ledger-policy.js";
import { COLLABORATION_HOT_TRIGGER, compactCollaborationProjectionV2 } from "../domains/collaboration/v2-retention.js";

type Command = Extract<BoardCommand, { type: "record_collaboration_v2" }>;

export function applyCollaborationV2(state: BoardState, command: Command): ReduceResult {
  const fact = command.fact, facts = state.collaborationV2Facts ?? [];
  if (!isCollaborationV2Fact(fact) || command.commandId !== `collaboration-v2:${fact.factId}`) return fail(state, "invalid_collaboration_fact", command.commandId);

  if (facts.some(f => f.factId === fact.factId)) return fail(state, "collaboration_fact_conflict", fact.factId);

  if (fact.kind === "cycle") {
    const previous = facts.filter((f): f is CollaborationCycleV2 => f.kind === "cycle" && f.cycleId === fact.cycleId).at(-1);
    if (previous?.factId !== command.expectedCycleFactId) return fail(state, "collaboration_fact_conflict", "cycle_claim_changed");
  }

  const reason = relationFailure(state, fact, "write");
  if (reason !== undefined) return fail(state, "collaboration_reference_invalid", reason);

  // Terminal quota accounting remains a body-free write after collection withdrawal.
  const terminalBudget = fact.kind === "cycle" && (fact.phase === "cancelled" || fact.phase === "failed");
  const cyclePins = fact.kind === "cycle" || fact.kind === "analysis" ? facts.filter(f => f.kind === "cycle" && f.cycleId === fact.cycleId).map(f => f.factId) : [];
  let working = state;
  const events: import("./events.js").BoardEvent[] = [];
  const archiveScope = (scope: string, mode: "normal" | "cold", pinned: readonly string[]) => {
    const plan = compactCollaborationProjectionV2(working, scope, command.issuedAt, pinned, mode);
    if (plan === undefined) return;
    events.push({ type: "collaboration_v2_compacted", sequence: nextSeq(state) + events.length,
      commandId: command.commandId, occurredAt: command.issuedAt, archive: plan.archive, archivedFacts: plan.removed });
    working = { ...working, collaborationV2Facts: plan.facts, collaborationV2Archives: plan.archives };
  };

  if (!terminalBudget) {
    if (facts.filter(f => f.scope === fact.scope).length >= COLLABORATION_HOT_TRIGGER) archiveScope(fact.scope, "normal", [...referencesOf(fact), ...cyclePins]);
    if ((working.collaborationV2Facts?.length ?? 0) >= COLLABORATION_HOT_TRIGGER * 4) {
      const scopes = [...new Set(working.collaborationV2Facts?.map(f => f.scope) ?? [])].filter(scope => scope !== fact.scope);
      for (const scope of scopes.slice(0, 2)) archiveScope(scope, "cold", []);
    }
  }

  events.push({ type: "collaboration_v2_recorded", sequence: nextSeq(state) + events.length,
    commandId: command.commandId, occurredAt: command.issuedAt, fact });

  return succeed(state, command.commandId, events, { collaborationV2Facts: [...(working.collaborationV2Facts ?? facts), fact],
    ...(working.collaborationV2Archives === undefined ? {} : { collaborationV2Archives: working.collaborationV2Archives }) });
}

export function validCollaborationV2Facts(state: BoardState, value: unknown): value is readonly CollaborationV2Fact[] {
  if (!Array.isArray(value) || !value.every(isCollaborationV2Fact)) return false;

  const prefix: CollaborationV2Fact[] = [];

  for (const fact of value) {
    if (prefix.some(f => f.factId === fact.factId) || relationFailure({ ...state, collaborationV2Facts: prefix }, fact, "snapshot") !== undefined) return false;
    prefix.push(fact);
  }

  return true;
}

function referencesOf(fact: CollaborationV2Fact): readonly string[] {
  if (fact.kind === "cycle") return [fact.factId, ...(fact.pinnedFactIds ?? [])];

  if (fact.kind === "analysis") return [...fact.basis.eventIds, ...fact.basis.episodeIds, ...fact.basis.outcomeIds, ...fact.basis.exposureIds, ...fact.basis.adoptionIds];

  if (fact.kind === "episode") return [...fact.eventIds, ...fact.evidenceRefs];

  if (fact.kind === "event") return [...fact.causedBy, ...fact.evidenceRefs];

  if (fact.kind === "adoption") return [fact.exposureId, ...fact.eventIds];

  if (fact.kind === "outcome") return [...fact.adoptionIds, ...fact.episodeIds];

  return [];
}

function relationFailure(state: BoardState, fact: CollaborationV2Fact, mode: "write" | "snapshot"): string | undefined {
  const facts = state.collaborationV2Facts ?? [];
  const sameScope = (id: string, kind: CollaborationV2Fact["kind"]): CollaborationV2Fact | undefined => facts.find(f => f.factId === id && f.scope === fact.scope && f.kind === kind);

  switch (fact.kind) {
    case "analysis": {
      const cycle = facts.filter((f): f is CollaborationCycleV2 => f.kind === "cycle" && f.cycleId === fact.cycleId).at(-1);
      if (cycle === undefined || cycle.phase !== "reserved" || cycle.scope !== fact.scope || cycle.step !== fact.step
        || cycle.sourceWindowHash !== fact.sourceWindowHash || facts.some(f => f.kind === "analysis" && f.cycleId === fact.cycleId && f.step === fact.step)) return "analysis_reservation_missing";
      return fact.basis.eventIds.every(id => sameScope(id, "event") !== undefined)
        && fact.basis.episodeIds.every(id => sameScope(id, "episode") !== undefined)
        && fact.basis.outcomeIds.every(id => sameScope(id, "outcome") !== undefined) ? undefined : "analysis_basis_missing";
    }
    case "event": return fact.causedBy.every(id => sameScope(id, "event") !== undefined) ? undefined : "event_cause_missing";
    case "episode": return fact.eventIds.every(id => {
      const event = sameScope(id, "event");
      return event?.kind === "event" && event.context.teamRunId === fact.context.teamRunId;
    }) ? undefined : "episode_event_missing";
    case "exposure": {
      const asset = state.assets.find(a => a.versionId === fact.versionId && a.scope === fact.scope);
      if (asset === undefined || !isCollaborationPracticeV2(asset.content)) return "exposure_version_missing";

      const practice = asset.content;
      if (!fact.actionIds.every(id => practice.actions.some(a => a.actionId === id && a.audience === fact.audience))) return "exposure_action_missing";

      if (mode === "snapshot") return undefined;

      const selected = selectCollaborationActionsV2(state, fact.context, fact.audience, 8000);

      return selected.kind === "selected" && selected.selectionId === fact.selectionId && selected.versionId === fact.versionId
        && selected.contentHash === fact.contentHash ? undefined : "stale_or_inapplicable_exposure";
    }
    case "adoption": {
      const exposure = sameScope(fact.exposureId, "exposure");
      if (exposure?.kind !== "exposure" || !exposure.actionIds.includes(fact.actionId)) return "adoption_exposure_missing";

      const asset = state.assets.find(a => a.versionId === exposure.versionId);
      if (asset === undefined || !isCollaborationPracticeV2(asset.content)) return "adoption_version_missing";

      const action = asset.content.actions.find(a => a.actionId === fact.actionId);

      return action !== undefined && fact.eventIds.every(id => {
        const event = sameScope(id, "event");
        return event?.kind === "event" && event.source === "runtime"
          && event.action === action.operation && event.dimension === action.dimension
          && event.context.teamRunId === exposure.context.teamRunId && event.context.taskId === exposure.context.taskId;
      }) ? undefined : "adoption_not_observed";
    }
    case "outcome": return fact.adoptionIds.every(id => sameScope(id, "adoption") !== undefined)
      && fact.episodeIds.every(id => sameScope(id, "episode") !== undefined) ? undefined : "outcome_reference_missing";
    case "correction": {
      if (!state.assets.some(a => a.scope === fact.scope && isCollaborationPracticeV2(a.content) && a.content.familyId === fact.familyId)) return "correction_family_missing";
      if (fact.action === "suspend") return fact.replacesCorrectionId === undefined ? undefined : "suspend_cannot_replace";
      const prior = facts.find(f => f.kind === "correction" && f.factId === fact.replacesCorrectionId && f.scope === fact.scope);
      return prior?.kind === "correction" && prior.action === "suspend" && prior.familyId === fact.familyId
        && contentHashOf(prior.appliesTo) === contentHashOf(fact.appliesTo) ? undefined : "restore_scope_mismatch";
    }
    case "cycle": {
      if (fact.reason === "recovered_unknown_outcome" && facts.some(f => f.kind === "analysis" && f.scope === fact.scope
        && f.cycleId === fact.cycleId && f.step === fact.step)) return "recovery_response_already_known";
      return cycleTransitionValid(facts.filter((f): f is CollaborationCycleV2 => f.kind === "cycle" && f.cycleId === fact.cycleId), fact)
        ? undefined : "cycle_transition_invalid";
    }
  }
}
