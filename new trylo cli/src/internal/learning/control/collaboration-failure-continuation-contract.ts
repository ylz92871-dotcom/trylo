import type { CentralLearningBudgetRootRef } from "./central-budget-contract.js";

/** Explicit inspection of a terminated generation, never automatic replay or new funds. */
export const COLLABORATION_INCOMPLETE_MODEL_FAILURES = ["learning_model_incomplete",
  "learning_model_output_truncated", "learning_model_follow_up_required"] as const;

export type CollaborationIncompleteModelFailure = (typeof COLLABORATION_INCOMPLETE_MODEL_FAILURES)[number];

export function isCollaborationIncompleteModelFailure(value: unknown): value is CollaborationIncompleteModelFailure {
  return COLLABORATION_INCOMPLETE_MODEL_FAILURES.some(reason => reason === value);
}

export type CollaborationFailureContinuation = {
  readonly failedReservationId: string;
  readonly failureReason: CollaborationIncompleteModelFailure;
  readonly checkpointReceiptId: string;
  readonly evidenceRef: string;
  readonly issueRevision: number;
  readonly continuedAt: string;
  readonly sequence: number;
  readonly commandId: string;
};

/** Host maintenance entry only. PA tools and model actions do not expose this authority. */
export type ResumeIncompleteCollaborationInput = {
  readonly jobId: string;
  readonly grantId: string;
  readonly expectedAttempt: number;
  readonly expectedIssueRevision: number;
  readonly expectedSequence: number;
  readonly failedReservationId: string;
  readonly checkpointReceiptId: string;
  readonly recoveryRef: string;
  readonly rootRef: CentralLearningBudgetRootRef;
};
