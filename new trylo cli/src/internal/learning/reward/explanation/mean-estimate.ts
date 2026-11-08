import { addToSum, emptySum } from "./residual-boundary.js";
import { allocateRevealChains, validateFeedbackPopulation } from "./reveal-chains.js";
import type { RevealOpportunity } from "./reveal-chains.js";
import { CHAIN_BUDGET_RULE, MEAN_COVERAGE_BASIS, projectBoundedMean, summarizeChainBoundaries, validateMeanDelta } from "./mean-bounds.js";
import type { ChainBoundarySummary, MeanInterval } from "./mean-bounds.js";

export type BoundedFeedbackUnit = {
  readonly unitId: string;
  readonly registeredAt: number;
  readonly center: number;
  readonly support: MeanInterval;
  readonly reveal?: { readonly at: number; readonly value: number };
};

export type BoundedMeanEstimate = {
  readonly schemaVersion: 1;
  readonly algorithm: "revealed_mean_eb_v1";
  readonly status: "estimated" | "no_data";
  readonly target: "prefix_average_registration_observer_conditional_mean";
  readonly population: number;
  readonly currentPointSupportCount: number;
  readonly observerRevealCount: number;
  readonly observerPendingCount: number;
  readonly chainCount: number;
  readonly residualScale: 1;
  readonly delta: number;
  readonly budgetRule: string;
  readonly coverageBasis: string;
  readonly actualMeanSupport: MeanInterval | null;
  readonly conditionalMeanBand: MeanInterval | null;
  readonly rawBand: MeanInterval | null;
  readonly totalBoundary: number;
  readonly chains: readonly ChainBoundarySummary[];
};

type MeanUnit = { readonly opportunity: RevealOpportunity; readonly center: number; readonly support: MeanInterval };

function bounded(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }

function canonicalUnit(input: BoundedFeedbackUnit): MeanUnit {
  if (typeof input !== "object" || input === null || !Array.isArray(input.support) || input.support.length !== 2) {
    throw new TypeError("feedback_bounded_unit_shape");
  }

  const { unitId, registeredAt, center, reveal } = input;
  let [lower, upper] = input.support;

  if (!bounded(center) || !bounded(lower) || !bounded(upper) || lower > upper) throw new RangeError("feedback_bounded_support");

  if (reveal !== undefined) {
    if (typeof reveal !== "object" || reveal === null || !bounded(reveal.value) || reveal.value < lower || reveal.value > upper) {
      throw new RangeError("feedback_reveal_conflicts_with_support");
    }
    lower = reveal.value;
    upper = reveal.value;
  }

  return { opportunity: { unitId, registeredAt, ...(reveal === undefined ? {} : { revealedAt: reveal.at }) },
    center, support: Object.freeze([lower, upper] as const) };
}

/** Caller supplies a fixed total outcome definition and reliable supports; this function does not certify them. */
export function estimateBoundedMean(input: readonly BoundedFeedbackUnit[], delta: number): BoundedMeanEstimate {
  validateMeanDelta(delta);
  validateFeedbackPopulation(input);
  const units = input.map(canonicalUnit);
  const layout = allocateRevealChains(units.map(unit => unit.opportunity));
  const variances = layout.chainCounts.map(() => emptySum());
  let lower = emptySum(), upper = emptySum(), currentPointSupportCount = 0;

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!, [lo, hi] = unit.support;
    const chain = layout.assignments[index]!.chainOrdinal - 1;
    lower = addToSum(lower, lo);
    upper = addToSum(upper, hi);
    variances[chain] = addToSum(variances[chain]!, Math.max((lo - unit.center) ** 2, (hi - unit.center) ** 2));
    currentPointSupportCount += Number(lo === hi);
  }

  const summary = summarizeChainBoundaries({ chainCounts: layout.chainCounts, normalizedVariances: variances.map(sum => sum.value),
    delta, tailCount: 2, residualScale: 1 });
  const projection = units.length === 0 ? { actualMeanSupport: null, conditionalMeanBand: null, rawBand: null }
    : projectBoundedMean({ population: units.length, lowerSum: lower.value, upperSum: upper.value, boundary: summary.totalBoundary });

  return Object.freeze({ schemaVersion: 1, algorithm: "revealed_mean_eb_v1", status: units.length === 0 ? "no_data" : "estimated",
    target: "prefix_average_registration_observer_conditional_mean", population: units.length, currentPointSupportCount,
    observerRevealCount: layout.revealedCount, observerPendingCount: layout.pendingCount, chainCount: layout.chainCounts.length,
    residualScale: 1, delta, budgetRule: `${CHAIN_BUDGET_RULE}; two tails`, coverageBasis: MEAN_COVERAGE_BASIS, ...projection, ...summary });
}
