import type { LearningAllocationBasis, LearningAllocationOffer, LearningAllocationResources } from "../allocation-contract.js";
import type { GaussianLimits } from "../prediction/index.js";

/** One total gross effect over a fixed use window, relative to the same no-new-learning rule.
 * Not a per-use score, probe information value, or net value with study cost already deducted. */
export type CentralResponseTarget = {
  readonly key: string;
  readonly utilityUnit: string;
  readonly referenceKey: string;
  readonly baselineRuleKey: string;
  readonly windowRef: string;
  /** Absent legacy targets describe deployed-learning outcomes only. Whole-policy
   * response includes failed, unused, and other-channel outcomes of every assignment. */
  readonly estimand?: "learning_policy_response" | "deployment_response";
};

export type CentralResponseOpportunity = {
  readonly opportunityId: string;
  readonly scope: string;
  readonly targetRef: string;
  readonly instanceRef: string;
  readonly sourceRef: string;
  readonly stage: "initial" | "continuation";
  readonly conditionRef: string;
  readonly baselineRef: string;
  readonly windowRef: string;
  readonly offer: LearningAllocationOffer;
};

/** The feedback owner resolves revisions before projection. unitId is an independent
 * learning/window episode, not each repeated checker or feedback event about that episode. */
export type CentralResponseHistory = CentralResponseOpportunity & {
  readonly unitId: string;
  /** Latest effective label availability; must remain within the planning prefix. */
  readonly sequence: number;
  /** Original episode order, stable across corrections; legacy inputs use sequence. */
  readonly episodeSequence?: number;
  readonly revisionRef: string;
  readonly outcome: { readonly kind: "paired_window"; readonly candidateUtility: number; readonly baselineUtility: number }
    | { readonly kind: "unknown"; readonly reason: string };
};

export type CentralResponseForecastInput = {
  readonly basis: LearningAllocationBasis;
  readonly target: CentralResponseTarget;
  readonly opportunities: readonly CentralResponseOpportunity[];
  readonly history: readonly CentralResponseHistory[];
  readonly limits: GaussianLimits;
};

export type CentralResponseRequirement = {
  readonly opportunityId: string;
  readonly reason: "paired_history_missing" | "history_variance_unidentified" | "pending_feedback";
  readonly sourceRefs: readonly string[];
};

export type CentralResponseForecastQuery = CentralResponseOpportunity & {
  readonly mean: number;
  /** Parameter uncertainty; null means unidentified, never certainty or zero noise. */
  readonly variance: number | null;
  readonly processVariance: number | null;
  readonly support: "calibrated_history" | "updated_history" | "bounded_reference_prior" | "updated_bounded_reference" | "empirical_history";
  readonly sourceRefs: readonly string[];
  readonly parameterRef: string;
  readonly calibrationUnitIds: readonly string[];
  readonly updateUnitIds: readonly string[];
  readonly population?: number;
  readonly pending?: number;
  readonly pendingMeanRange?: readonly [number, number];
  /** Source-declared actual whole-window outcome support, not posterior uncertainty. */
  readonly grossSupport?: { readonly minimum: number; readonly maximum: number; readonly sourceRef: string };
};

export type CentralResponseForecast = {
  readonly schemaVersion: 1;
  readonly forecastRef: string;
  readonly basis: LearningAllocationBasis;
  readonly target: CentralResponseTarget;
  readonly interpretation: "fixed_window_gross_increment";
  readonly queries: readonly CentralResponseForecastQuery[];
  /** Query order equals queries. Cross-stratum covariance is unknown, never fabricated zero. */
  readonly joint: { readonly mean: readonly number[]; readonly covariance: readonly (readonly (number | null)[])[] };
  readonly requirements: readonly CentralResponseRequirement[];
  readonly modelAssumptions?: readonly string[];
};

export type CentralResponseForecastResult = { readonly status: "ready"; readonly value: CentralResponseForecast }
  | { readonly status: "invalid" | "unsupported"; readonly reason: string; readonly detail: string };

export type CentralResponseProducer = (input: CentralResponseForecastInput) => CentralResponseForecastResult;

/** Reported spend only; these moments cannot authorize a smaller reserve or predict a refund. */
export type CentralResponseCost = {
  readonly status: "reported";
  readonly grantId: string;
  readonly sourceRef: string;
  readonly resources: LearningAllocationResources;
} | { readonly status: "unknown"; readonly grantId: string; readonly sourceRef: string; readonly reason: string };
