import type { RewardExposure, RewardExposureDraft, RewardFeedback, RewardRecords, RewardSignal, RewardProjection } from "./contracts.js";

export type RewardFailure = { readonly ok: false; readonly reason: string };
export type RewardDelivery = { readonly ok: true; readonly delivery: "delivered" | "pending"; readonly revision: number } | RewardFailure;
export type RewardWrite = { readonly ok: true; readonly duplicate: boolean; readonly records: RewardRecords;
  readonly delivery?: "delivered" | "pending" } | RewardFailure;
/** Every learning subsystem uses this same seam; no filesystem or UI types cross it. */
export type RewardLedgerPort = {
  readonly expose: (input: RewardExposureDraft) => Promise<RewardWrite>;
  readonly feedback: (input: RewardFeedback) => Promise<RewardWrite>;
  readonly read: () => Promise<({ readonly ok: true; readonly records: RewardRecords }) | RewardFailure>;
};
export type RewardOutputPort = {
  /** Replace the scope projection only if revision >= the consumer's durable revision. */
  readonly replace: (projection: RewardProjection) => Promise<void>;
};
export type RewardInputPort = {
  readonly expose: RewardLedgerPort["expose"];
  readonly feedback: RewardLedgerPort["feedback"];
  readonly signals: (scope: string) => Promise<({ readonly ok: true; readonly signals: readonly RewardSignal[] }) | RewardFailure>;
  readonly sync: (scope: string) => Promise<RewardDelivery>;
  readonly inspect: (exposureId: string) => Promise<({ readonly ok: true; readonly exposure: RewardExposure;
    readonly feedbacks: readonly RewardFeedback[] }) | RewardFailure>;
};
export type RewardFact = { readonly eventId: string; readonly summary: string };
export type RewardReasonerPort = {
  readonly interpret: (input: { readonly prompt: string; readonly maxOutputTokens: number;
    readonly signal: AbortSignal; readonly requestId: string }) => Promise<string>;
};
export type RewardAppraisalInput = {
  readonly exposure: RewardExposure;
  readonly facts: readonly RewardFact[];
  readonly signal: AbortSignal;
};
