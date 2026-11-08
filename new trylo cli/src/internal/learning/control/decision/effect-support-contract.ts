import type { CentralResponseTarget } from "./prediction-input.js";

/** These are already-effective source revisions. This module never chooses a
 * revision head or promotes a proposed/model-written score into a measurement. */
export type CentralEffectMeasurement = {
  readonly comparisonId: string;
  readonly revisionRef: string;
  readonly sourceRef: string;
  readonly outcome: { readonly kind: "measured"; readonly candidateUtility: number; readonly baselineUtility: number }
    | { readonly kind: "unknown"; readonly reason: string };
};

export type CentralEffectWindow = {
  readonly unitId: string;
  readonly revisionRef: string;
  readonly sourceRef: string;
  /** The entire prospectively registered cohort, including comparisons with no
   * feedback record yet. Omission from measurements does not remove this member. */
  readonly comparisonIds: readonly string[];
  readonly measurements: readonly CentralEffectMeasurement[];
};

export type CentralEffectSupportInput = {
  readonly target: CentralResponseTarget;
  /** Fixed by the source definition of target.windowRef, not inferred by counting
   * whichever measurements happened to be revealed. */
  readonly comparisonsPerWindow: number;
  readonly deltaBounds: { readonly minimum: number; readonly maximum: number; readonly sourceRef: string };
  readonly windows: readonly CentralEffectWindow[];
};

export type CentralEffectWindowSupport = {
  readonly unitId: string;
  readonly revisionRef: string;
  readonly sourceRef: string;
  readonly status: "complete" | "pending";
  readonly registeredComparisons: number;
  readonly knownComparisons: number;
  readonly unknownComparisons: number;
  readonly grossSupport: readonly [number, number];
  readonly pendingComparisonIds: readonly string[];
  readonly sourceRefs: readonly string[];
};

export type CentralEffectSupport = {
  readonly schemaVersion: 1;
  readonly supportRef: string;
  readonly target: CentralResponseTarget;
  readonly interpretation: "actual_registered_window_support";
  /** Compensated ordinary-double arithmetic, not a directed-rounding certificate. */
  readonly numericScope: "ordinary_double_not_directed_rounding";
  readonly population: number;
  readonly completeWindows: number;
  readonly pendingWindows: number;
  readonly registeredComparisons: number;
  readonly knownComparisons: number;
  readonly unknownComparisons: number;
  readonly windows: readonly CentralEffectWindowSupport[];
  readonly totalGrossSupport: readonly [number, number];
  /** The average of this fixed registered population, never a next-use forecast,
   * a Gaussian observation variance, or a confidence interval. Empty means null. */
  readonly actualMeanSupport: readonly [number, number] | null;
  readonly sourceRefs: readonly string[];
};

export type CentralEffectSupportResult = { readonly status: "ready"; readonly value: CentralEffectSupport }
  | { readonly status: "invalid" | "unsupported"; readonly reason: string };
