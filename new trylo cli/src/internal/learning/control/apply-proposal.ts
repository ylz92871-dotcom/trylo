import type {
  FastLaneValidateCommand,
  QuarantineCommand,
  RejectCommand,
  RequestApprovalCommand,
  StartEvaluationCommand,
  SubmitProposalCommand,
} from "./commands.js";
import type { LearningProposal } from "./contracts.js";
import { isBroadScope } from "./contracts.js";
import type { ReduceResult } from "./result.js";
import { fail, nextSeq, succeed } from "./result.js";
import {
  findProposal,
  findTombstone,
  replaceById,
  type BoardState,
} from "./state.js";
import { expectedTo } from "./transitions.js";

export function applySubmit(
  state: BoardState,
  command: SubmitProposalCommand,
): ReduceResult {
  const draft = command.proposal;
  if (findTombstone(state, draft.proposalId)) {
    return fail(state, "tombstone_exists", draft.proposalId);
  }

  if (findProposal(state, draft.proposalId)) {
    return fail(state, "duplicate_proposal", draft.proposalId);
  }

  if (
    draft.domain === "compound" &&
    (draft.compoundChildIds === undefined || draft.compoundChildIds.length === 0)
  ) {
    return fail(state, "compound_must_be_explicit", draft.proposalId);
  }

  const proposal: LearningProposal = { ...draft, lifecycle: "draft" };
  const sequence = nextSeq(state);

  return succeed(
    state,
    command.commandId,
    [
      {
        type: "proposal_submitted",
        sequence,
        commandId: command.commandId,
        occurredAt: command.issuedAt,
        proposal,
      },
    ],
    { proposals: [...state.proposals, proposal] },
  );
}

export function applySimpleTransition(
  state: BoardState,
  command: QuarantineCommand | StartEvaluationCommand | RejectCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }

  const to = expectedTo(proposal.lifecycle, command.type);
  if (to === undefined) {
    return fail(
      state,
      "illegal_transition",
      `${proposal.lifecycle}->${command.type}`,
    );
  }

  return transitionProposal(state, command.commandId, command.issuedAt, proposal, to);
}

export function applyFastLaneValidate(
  state: BoardState,
  command: FastLaneValidateCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }

  if (expectedTo(proposal.lifecycle, "fast_lane_validate") !== "validated") {
    return fail(
      state,
      "illegal_transition",
      `${proposal.lifecycle}->fast_lane_validate`,
    );
  }

  const gated = fastLaneGate(proposal);
  if (gated !== undefined) {
    return fail(state, gated.reason, gated.detail);
  }

  return transitionProposal(
    state,
    command.commandId,
    command.issuedAt,
    proposal,
    "validated",
  );
}

export function applyRequestApproval(
  state: BoardState,
  command: RequestApprovalCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }

  if (expectedTo(proposal.lifecycle, "request_approval") !== "awaiting_approval") {
    return fail(
      state,
      "illegal_transition",
      `${proposal.lifecycle}->request_approval`,
    );
  }

  const next = { ...proposal, lifecycle: "awaiting_approval" as const };
  const approval = {
    approvalId: command.approvalId,
    proposalId: proposal.proposalId,
    action: command.action,
    status: "pending" as const,
    requestedAuthorities: proposal.requestedAuthorities,
  };
  const sequence = nextSeq(state);

  return succeed(
    state,
    command.commandId,
    [
      {
        type: "proposal_transitioned",
        sequence,
        commandId: command.commandId,
        occurredAt: command.issuedAt,
        proposalId: proposal.proposalId,
        from: proposal.lifecycle,
        to: "awaiting_approval",
      },
      {
        type: "approval_changed",
        sequence: sequence + 1,
        commandId: command.commandId,
        occurredAt: command.issuedAt,
        approval,
      },
    ],
    {
      proposals: replaceById(
        state.proposals,
        (item) => item.proposalId === proposal.proposalId,
        next,
      ),
      approvals: [...state.approvals, approval],
    },
  );
}

export function transitionProposal(
  state: BoardState,
  commandId: string,
  occurredAt: string,
  proposal: LearningProposal,
  to: LearningProposal["lifecycle"],
): ReduceResult {
  const next = { ...proposal, lifecycle: to };
  const sequence = nextSeq(state);

  return succeed(
    state,
    commandId,
    [
      {
        type: "proposal_transitioned",
        sequence,
        commandId,
        occurredAt,
        proposalId: proposal.proposalId,
        from: proposal.lifecycle,
        to,
      },
    ],
    {
      proposals: replaceById(
        state.proposals,
        (item) => item.proposalId === proposal.proposalId,
        next,
      ),
    },
  );
}

function fastLaneGate(
  proposal: LearningProposal,
): { reason: "inferred_cannot_skip_verification" | "fast_lane_wrong_kind" | "fast_lane_scope_rejected" | "fast_lane_authority_rejected" | "fast_lane_source_rejected" | "fast_lane_risk_rejected"; detail: string } | undefined {
  if (proposal.source !== "user_explicit") {
    return proposal.source === "inferred"
      ? { reason: "inferred_cannot_skip_verification", detail: proposal.proposalId }
      : { reason: "fast_lane_source_rejected", detail: proposal.source };
  }

  if (proposal.assetKind !== "user_rule") {
    return { reason: "fast_lane_wrong_kind", detail: proposal.assetKind };
  }

  if (isBroadScope(proposal.scope)) {
    return { reason: "fast_lane_scope_rejected", detail: proposal.scope };
  }

  if (proposal.requestedAuthorities.length > 0) {
    return { reason: "fast_lane_authority_rejected", detail: proposal.proposalId };
  }

  if (proposal.risk === "high") {
    return { reason: "fast_lane_risk_rejected", detail: proposal.proposalId };
  }

  return undefined;
}
