/** Objects and metrics are versioned extension points, not a closed list of current subsystems. */
export type RewardMetric = {
  readonly id: string;
  readonly version: string;
  readonly unit: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly preference: "higher" | "lower";
};
export const REWARD_ORIGINS = ["environment", "user", "model"] as const;
export type RewardOrigin = (typeof REWARD_ORIGINS)[number];
export type RewardTarget = {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
};
export type RewardContext = {
  readonly scope: string;
  readonly taskFamily: string;
  readonly environment: string;
  readonly metric: RewardMetric;
};
export type RewardSource = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly eventId: string;
};
export type RewardExposureDraft = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: RewardSource;
  readonly context: RewardContext;
  readonly targets: readonly RewardTarget[];
  readonly occurredAt: number;
  /** Optional host-captured feedback watermark. Deferred sensors use a pre-execution basis. */
  readonly priorFeedbackCount?: number;
};
export type RewardEstimate = { readonly mean: number; readonly variance: number };
export type RewardPrediction = { readonly target: RewardTarget; readonly estimate: RewardEstimate };
export type RewardExposure = RewardExposureDraft & { readonly predictions: readonly RewardPrediction[] };
export type RewardMeasurement =
  /** noiseVariance is measured on normalized utility [-1,1], never raw units such as milliseconds squared. */
  | { readonly kind: "measured"; readonly value: number; readonly confidence: number; readonly noiseVariance: number }
  | { readonly kind: "unknown"; readonly reason: "cancelled" | "denied" | "unverified" | "missing" };
export type RewardAttribution =
  | { readonly kind: "linked"; readonly shares: readonly { readonly target: RewardTarget; readonly share: number }[] }
  | { readonly kind: "unresolved" | "external" };
export type RewardFeedback = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly exposureId: string;
  readonly source: RewardSource;
  readonly origin: RewardOrigin;
  readonly evidenceIds: readonly string[];
  readonly outcome: RewardMeasurement;
  readonly attribution: RewardAttribution;
  readonly observedAt: number;
  readonly supersedes?: string;
};
export type RewardAdjustment = {
  readonly target: RewardTarget;
  readonly predictionError: number;
  readonly innovation: number;
  readonly gain: number;
  readonly signedCredit: number;
  readonly before: RewardEstimate;
  readonly after: RewardEstimate;
};
export type RewardSignal = {
  readonly schemaVersion: 1;
  readonly feedbackId: string;
  readonly exposureId: string;
  readonly context: RewardContext;
  readonly origin: RewardOrigin;
  readonly source: RewardSource;
  readonly evidenceIds: readonly string[];
  readonly outcome: RewardMeasurement;
  readonly normalizedValue?: number;
  readonly adjustments: readonly RewardAdjustment[];
  readonly unassignedShare: number;
  readonly investigationPressure: number;
  /** Sign of aggregate frozen prediction-error credit, not movement of the current estimates. */
  readonly direction: "positive_credit" | "negative_credit" | "investigate" | "observe";
};
export type RewardRecords = {
  readonly exposures: readonly RewardExposure[];
  readonly feedbacks: readonly RewardFeedback[];
};
/** Authoritative replacement, not an additive reward command. Consumers ignore older revisions. */
export type RewardProjection = {
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly revision: number;
  readonly signals: readonly RewardSignal[];
};

export const MAX_REWARD_TARGETS = 16;
export const MAX_REWARD_EXPOSURES = 4096;
export const MAX_REWARD_FEEDBACKS = 16384;

/** Structured tuple keys avoid delimiter collisions and prototype-key pollution. */
export function targetKey(target: RewardTarget): string {
  return JSON.stringify([target.kind, target.id, target.version]);
}
export function estimateKey(context: RewardContext, target: RewardTarget): string {
  return JSON.stringify([context.scope, context.taskFamily, context.environment, context.metric.id,
    context.metric.version, targetKey(target)]);
}
