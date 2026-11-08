import type {
  ExternalVerdict,
  WeakSignal,
} from "../learning/domains/shared/types.js";

export const EVALUATION_VERDICTS = [
  "recommend_shadow",
  "reject",
  "insufficient_sample",
  "no_external_pass",
  "critical_regression",
] as const;

export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

export type EvaluationMetrics = {
  readonly successImproved: boolean;
  readonly qualityDelta: number;
  readonly costDelta: number;
  readonly latencyDelta: number;
  readonly criticalRegression: boolean;
  readonly failureDiversity: number;
  readonly successRate: number;
};

export type ReplayCompare = {
  readonly baselineRef: string;
  readonly candidateRef: string;
  readonly compared: true;
};

export type ConfidenceInterval = {
  readonly n: number;
  readonly low: number;
  readonly high: number;
};

export type KeepBestResult =
  | {
      readonly kind: "keep_candidate";
      readonly activationEligible: false;
      readonly proposalId: string;
    }
  | { readonly kind: "keep_baseline"; readonly reason: EvaluationVerdict };

export type EvaluationEvidenceDraft = {
  readonly proposalId: string;
  readonly baselineRef: string;
  readonly candidateRef: string;
  readonly replay: ReplayCompare;
  readonly externalAnchors: readonly ExternalVerdict[];
  readonly weakSignals: readonly WeakSignal[];
  readonly negativeCritique: readonly string[];
  readonly metrics: EvaluationMetrics;
  readonly verdict: EvaluationVerdict;
  readonly externalPass: boolean;
  readonly sampleConfidence: "sufficient" | "insufficient";
  readonly confidenceInterval: ConfidenceInterval;
  readonly generatorRoleId: string;
  readonly evaluatorRoleId: string;
  readonly notes: readonly string[];
  readonly deterministicChecks: readonly string[];
  readonly shadowRecommended: boolean;
  readonly threshold: number;
  readonly commandKind: "submit_evidence";
};

export type EvaluationRequest = {
  readonly proposalId: string;
  readonly baselineRef: string;
  readonly candidateRef: string;
  readonly generatorRoleId: string;
  readonly evaluatorRoleId: string;
  readonly baselineAnchors: readonly ExternalVerdict[];
  readonly candidateAnchors: readonly ExternalVerdict[];
  readonly weakSignals: readonly WeakSignal[];
  readonly costDelta: number;
  readonly latencyDelta: number;
  readonly outputLengthDelta: number;
  readonly criticalRegressionFailed: boolean;
  readonly failureDiversity: number;
  readonly sampleSize: number;
  readonly threshold?: number;
  readonly judgeRubricScore?: number;
};
