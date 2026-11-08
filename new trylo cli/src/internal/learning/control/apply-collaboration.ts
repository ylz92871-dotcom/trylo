import type { CollaborationFact } from "../domains/collaboration/contracts.js";
import { isCollaborationFact, isCollaborationPractice } from "../domains/collaboration/parse.js";
import { selectPractice } from "../domains/collaboration/selection.js";
import type { BoardCommand } from "./commands.js";
import { contentHashOf } from "./hash.js";
import { fail, nextSeq, succeed, type ReduceResult } from "./result.js";
import type { BoardState } from "./state.js";

export const MAX_COLLABORATION_FACTS = 10000;

type FactCommand = Extract<BoardCommand, { type: "record_collaboration_fact" }>;

export function applyCollaborationFact(state: BoardState, command: FactCommand): ReduceResult {
  const fact = command.fact;
  if (!isCollaborationFact(fact)) return fail(state, "invalid_collaboration_fact", command.commandId);

  const facts = state.collaborationFacts ?? [];
  if (facts.some(item => item.factId === fact.factId)) return fail(state, "collaboration_fact_conflict", fact.factId);

  if (facts.length >= MAX_COLLABORATION_FACTS) return fail(state, "collaboration_fact_capacity", fact.factId);

  const reason = factRelationFailure(state, fact);
  if (reason !== undefined) return fail(state, "collaboration_reference_invalid", reason);

  return succeed(state, command.commandId, [{ type: "collaboration_fact_recorded", sequence: nextSeq(state),
    commandId: command.commandId, occurredAt: command.issuedAt, fact }], { collaborationFacts: [...facts, fact] });
}

/** Validate references in a snapshot as well as on command replay; absence alone means old format. */
export function validCollaborationFacts(state: BoardState, value: unknown): value is readonly CollaborationFact[] {
  if (!Array.isArray(value) || value.length > MAX_COLLABORATION_FACTS || !value.every(isCollaborationFact)) return false;

  const prefix: CollaborationFact[] = [];

  for (const fact of value) {
    if (prefix.some(item => item.factId === fact.factId)) return false;
    if (factRelationFailure({ ...state, collaborationFacts: prefix }, fact, "snapshot") !== undefined) return false;
    prefix.push(fact);
  }

  return true;
}

function factRelationFailure(state: BoardState, fact: CollaborationFact, mode: "write" | "snapshot" = "write"): string | undefined {
  const facts = state.collaborationFacts ?? [];

  if (fact.kind === "episode") return undefined;

  if (fact.kind === "diagnosis") {
    const subject = facts.find(item => item.factId === fact.subjectFactId && item.scope === fact.scope);
    if (subject === undefined || (subject.kind !== "episode" && subject.kind !== "outcome")) return "diagnosis_subject_missing";
    if (facts.some(item => item.kind === "diagnosis" && item.subjectFactId === fact.subjectFactId)) return "diagnosis_already_recorded";
    return fact.versionId === undefined || state.assets.some(item => item.versionId === fact.versionId && item.scope === fact.scope
      && isCollaborationPractice(item.content)) ? undefined : "diagnosis_version_missing";
  }

  if (fact.kind === "outcome") {
    const fielding = facts.find(item => item.kind === "fielding" && item.factId === fact.fieldingId && item.scope === fact.scope);
    if (fielding === undefined) return "outcome_fielding_missing";
    if (fact.result.check !== "unverified" && facts.some(item => item.kind === "outcome" && item.fieldingId === fact.fieldingId
      && item.result.check !== "unverified")) return "outcome_already_checked";
    return undefined;
  }

  const versionId = fact.kind === "correction" ? fact.targetVersionId : fact.versionId;
  const asset = state.assets.find(item => item.versionId === versionId && item.scope === fact.scope && isCollaborationPractice(item.content));
  if (asset === undefined) return "practice_missing_or_scope_mismatch";

  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId && item.domain === "collaboration");
  if (proposal === undefined) return "collaboration_proposal_missing";

  if (fact.kind === "correction") return undefined;

  if (fact.proposalId !== proposal.proposalId) return "fielding_proposal_mismatch";

  if (facts.some(item => item.kind === "fielding" && item.requestId === fact.requestId && item.scope === fact.scope
    && item.context.taskId === fact.context.taskId && item.context.round === fact.context.round)) return "fielding_already_recorded";

  if (!fact.correctionIds.every(id => facts.some(item => item.kind === "correction" && item.factId === id
    && item.scope === fact.scope))) return "fielding_correction_missing";

  // Past dispatches remain true after later suspension/correction. Fresh ones must use the current decision.
  if (mode === "snapshot") return undefined;

  const selected = selectPractice(state, fact.context, 16000);

  return selected.kind === "selected" && selected.versionId === fact.versionId
    && contentHashOf(selected.correctionIds) === contentHashOf(fact.correctionIds) ? undefined : "stale_or_inapplicable_fielding";
}
