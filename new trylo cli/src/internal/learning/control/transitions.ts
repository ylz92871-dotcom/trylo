import type { ProposalLifecycle } from "./contracts.js";
import type { CommandType } from "./commands.js";

export type TransitionRule = {
  readonly from: ProposalLifecycle;
  readonly to: ProposalLifecycle;
  readonly command: CommandType;
};

export const LEGAL_PROPOSAL_TRANSITIONS: ReadonlyArray<TransitionRule> = [
  // Standard proposals collect evidence before requesting activation.
  { from: "draft", to: "quarantined", command: "quarantine" },
  { from: "quarantined", to: "evaluating", command: "start_evaluation" },
  { from: "evaluating", to: "shadow", command: "enter_shadow" },
  { from: "shadow", to: "awaiting_approval", command: "request_approval" },
  { from: "awaiting_approval", to: "active", command: "activate" },

  // The explicit fast lane validates before activation as a separate path.
  { from: "draft", to: "validated", command: "fast_lane_validate" },
  { from: "validated", to: "active", command: "activate" },

  { from: "draft", to: "rejected", command: "reject" },
  { from: "quarantined", to: "rejected", command: "reject" },
  { from: "evaluating", to: "rejected", command: "reject" },
  { from: "shadow", to: "rejected", command: "reject" },
  { from: "awaiting_approval", to: "rejected", command: "reject" },

  // Active proposals must be suspended before rollback or retirement.
  { from: "active", to: "suspended", command: "suspend" },
  { from: "suspended", to: "active", command: "resume" },
  { from: "suspended", to: "rolled_back", command: "rollback" },
  { from: "suspended", to: "retired", command: "retire" },
];

export const REJECT_SOURCES: ReadonlyArray<ProposalLifecycle> = [
  "draft",
  "quarantined",
  "evaluating",
  "shadow",
  "awaiting_approval",
];

export function isLegalTransition(
  from: ProposalLifecycle,
  command: CommandType,
  to: ProposalLifecycle,
): boolean {
  return LEGAL_PROPOSAL_TRANSITIONS.some(
    (rule) => rule.from === from && rule.command === command && rule.to === to,
  );
}

export function expectedTo(
  from: ProposalLifecycle,
  command: CommandType,
): ProposalLifecycle | undefined {
  const match = LEGAL_PROPOSAL_TRANSITIONS.find(
    (rule) => rule.from === from && rule.command === command,
  );
  return match?.to;
}

export const ILLEGAL_TRANSITION_EXAMPLES: ReadonlyArray<{
  readonly from: ProposalLifecycle;
  readonly command: CommandType;
  readonly to: ProposalLifecycle;
}> = [
  { from: "draft", command: "activate", to: "active" },
  { from: "draft", command: "enter_shadow", to: "shadow" },
  { from: "quarantined", command: "activate", to: "active" },
  { from: "evaluating", command: "activate", to: "active" },
  { from: "shadow", command: "activate", to: "active" },
  { from: "active", command: "reject", to: "rejected" },
  { from: "rejected", command: "activate", to: "active" },
  { from: "retired", command: "resume", to: "active" },
  { from: "rolled_back", command: "resume", to: "active" },
  { from: "validated", command: "quarantine", to: "quarantined" },
  { from: "active", command: "fast_lane_validate", to: "validated" },
  { from: "suspended", command: "reject", to: "rejected" },
];
