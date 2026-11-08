/** Learning money only. No fact in this contract authorizes an execution tool. */
export type LearningGrantUsage =
  | { readonly kind: "reported"; readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }
  | { readonly kind: "unknown"; readonly reason: string;
      readonly observed?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number } };

type Base = { readonly schemaVersion: 1; readonly grantId: string };

export type LearningGrantDraft = Base & (
  | { readonly kind: "open"; readonly subsystem: "skill"; readonly workspaceId: string; readonly sourceRef: string;
      readonly allowance: { readonly maxCalls: number; readonly maxOutputTokens: number } }
  | { readonly kind: "reserve"; readonly reservationId: string; readonly maxOutputTokens: number }
  | { readonly kind: "settle"; readonly reservationId: string; readonly usage: LearningGrantUsage }
  | { readonly kind: "close"; readonly reason: "completed" | "cancelled" | "failed" | "budget_exhausted" }
);

export type LearningGrantFact = LearningGrantDraft & { readonly boardSequence: number };

export type LearningGrantReservation = { readonly reservationId: string; readonly maxOutputTokens: number } & (
  | { readonly state: "reserved" }
  | { readonly state: "reported"; readonly usage: Extract<LearningGrantUsage, { kind: "reported" }> }
  | { readonly state: "unknown"; readonly usage: Extract<LearningGrantUsage, { kind: "unknown" }> }
);

export type LearningGrantSnapshot = {
  readonly grantId: string;
  readonly workspaceId: string;
  readonly sourceRef: string;
  readonly allowance: { readonly maxCalls: number; readonly maxOutputTokens: number };
  readonly reservations: readonly LearningGrantReservation[];
  readonly callsReserved: number;
  readonly reportedInputTokens: number;
  readonly reportedOutputTokens: number;
  readonly reportedTotalTokens: number;
  readonly status: "open" | "in_flight" | "unknown" | "overrun" | "closed";
  readonly closedReason?: Extract<LearningGrantDraft, { kind: "close" }>["reason"];
};

export type LearningGrantFailureCode = "invalid_learning_grant" | "learning_grant_conflict" | "learning_grant_exhausted"
  | "learning_grant_unsettled" | "learning_grant_closed" | "learning_grant_not_found" | "learning_grant_scope_mismatch" | "learning_grant_capacity";

export const MAX_LEARNING_GRANT_FACTS = 65536;
