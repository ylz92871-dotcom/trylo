import type { ResumeCommand, RetireCommand, RollbackCommand, SuspendCommand } from "./commands.js";
import type { ActivationRecord } from "./contracts.js";
import {
  casMismatch,
  commitLifecycleAndPointer,
  type UnstampedActivation,
} from "./apply-asset.js";
import type { ReduceResult } from "./result.js";
import { fail } from "./result.js";
import {
  findActivationByProposal,
  findAsset,
  findProposal,
  activationOwnedBy,
  type BoardState,
} from "./state.js";
import { expectedTo } from "./transitions.js";

export function applySuspend(
  state: BoardState,
  command: SuspendCommand,
): ReduceResult {
  return moveActivePointer(state, command, "suspended", command.breakerReason);
}

export function applyResume(
  state: BoardState,
  command: ResumeCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }
  const existing = findActivationByProposal(state, proposal);
  if (casMismatch(command.expectedGeneration, existing)) {
    return fail(state, "activation_cas_mismatch", String(existing?.generation ?? 0));
  }
  return moveActivePointer(state, command, "active");
}

export function applyRollback(
  state: BoardState,
  command: RollbackCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }
  if (expectedTo(proposal.lifecycle, "rollback") !== "rolled_back") {
    return fail(state, "illegal_transition", `${proposal.lifecycle}->rollback`);
  }
  const existing = findActivationByProposal(state, proposal);
  if (existing === undefined) {
    return fail(state, "activation_not_found", command.proposalId);
  }
  if (!activationOwnedBy(state, existing, proposal)) return fail(state, "illegal_transition", "proposal no longer owns this activation");
  if (existing.previousVersionId === undefined) {
    return commitLifecycleAndPointer(
      state,
      command.commandId,
      command.issuedAt,
      proposal,
      "rolled_back",
      withRollback(existing, "rolled_back", existing.versionId, command.reason),
    );
  }
  if (findAsset(state, existing.previousVersionId) === undefined) {
    return fail(state, "rollback_target_missing", existing.previousVersionId);
  }
  return commitLifecycleAndPointer(
    state,
    command.commandId,
    command.issuedAt,
    proposal,
    "rolled_back",
    withRollback(existing, "active", existing.previousVersionId, command.reason, existing.versionId),
  );
}

export function applyRetire(
  state: BoardState,
  command: RetireCommand,
): ReduceResult {
  return moveActivePointer(state, command, "retired");
}

function moveActivePointer(
  state: BoardState,
  command: SuspendCommand | ResumeCommand | RetireCommand,
  pointer: ActivationRecord["pointer"],
  breakerReason?: string,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }
  const to = expectedTo(proposal.lifecycle, command.type);
  if (to === undefined) {
    return fail(state, "illegal_transition", `${proposal.lifecycle}->${command.type}`);
  }
  const existing = findActivationByProposal(state, proposal);
  if (existing === undefined) {
    return fail(state, "activation_not_found", command.proposalId);
  }
  if (!activationOwnedBy(state, existing, proposal)) return fail(state, "illegal_transition", "proposal no longer owns this activation");
  const breaker = command.type === "resume" ? undefined :
    breakerReason === undefined
      ? existing.breaker
      : {
          open: true,
          reason: breakerReason,
          consecutiveFailures: (existing.breaker?.consecutiveFailures ?? 0) + 1,
        };
  const next: UnstampedActivation = {
    ...omitBreaker(existing),
    pointer,
    generation: existing.generation + 1,
    ...(breaker !== undefined ? { breaker } : {}),
  };
  return commitLifecycleAndPointer(
    state,
    command.commandId,
    command.issuedAt,
    proposal,
    to,
    next,
  );
}

function omitBreaker(activation: ActivationRecord): Omit<ActivationRecord, "boardSequence" | "breaker"> {
  const { breaker: _breaker, ...rest } = omitBoardSequence(activation);
  return rest;
}

/** 去 stamp 后再交给 commitLifecycleAndPointer，避免把旧序号带进新事件。 */
function omitBoardSequence(activation: ActivationRecord): Omit<ActivationRecord, "boardSequence"> {
  const { boardSequence: _ignored, ...rest } = activation;
  return rest;
}

function withRollback(
  existing: ActivationRecord,
  pointer: ActivationRecord["pointer"],
  versionId: string,
  reason: string,
  previousVersionId?: string,
): UnstampedActivation {
  const withoutBreaker = omitBreaker(existing);
  const next: UnstampedActivation = {
    ...(pointer === "active" && versionId !== existing.versionId ? withoutBreaker : omitBoardSequence(existing)),
    pointer,
    versionId,
    generation: existing.generation + 1,
    rollbackReason: reason,
  };
  if (previousVersionId === undefined) {
    return next;
  }
  return { ...next, previousVersionId };
}
