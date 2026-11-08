import { allocateRevealChains, validateFeedbackPopulation } from "./reveal-chains.js";
import { CHAIN_BUDGET_RULE, MEAN_COVERAGE_BASIS, projectBoundedMean, summarizeChainBoundaries, validateMeanDelta } from "./mean-bounds.js";
import type { ChainBoundarySummary, MeanInterval } from "./mean-bounds.js";

export type ReportedFeedbackUnit = { readonly unitId: string; readonly registeredAt: number } & (
  | { readonly status: "pending" }
  | { readonly status: "success" | "failure" | "other"; readonly revealedAt: number }
);

export type ReportedMeanRanges = {
  readonly success: MeanInterval;
  readonly failure: MeanInterval;
  readonly otherOrNever: MeanInterval;
};

export type ReportedFeedbackEstimate = {
  readonly schemaVersion: 1;
  readonly algorithm: "reported_sfn_eb_v1";
  readonly status: "estimated" | "no_data";
  readonly target: "prefix_average_registration_observer_first_close_indicators";
  readonly population: number;
  readonly counts: { readonly success: number; readonly failure: number; readonly closedOther: number; readonly pending: number };
  readonly chainCount: number;
  readonly residualScale: 0.5;
  readonly centerRole: "predictable_nuisance_constant_half";
  readonly delta: number;
  readonly budgetRule: string;
  readonly coverageBasis: string;
  readonly interpretation: "reported_channel_only_not_task_quality_or_causal_credit";
  readonly actualMeanSupport: ReportedMeanRanges | null;
  readonly conditionalMeanBands: ReportedMeanRanges | null;
  readonly totalBoundary: number;
  readonly chains: readonly ChainBoundarySummary[];
};

function reportOpportunity(unit: ReportedFeedbackUnit) {
  if (typeof unit !== "object" || unit === null) throw new TypeError("feedback_report_unit_shape");

  if (unit.status === "pending") {
    if ("revealedAt" in unit) throw new RangeError("pending_report_has_reveal");
    return { unitId: unit.unitId, registeredAt: unit.registeredAt };
  }

  if (!["success", "failure", "other"].includes(unit.status) || !Number.isSafeInteger(unit.revealedAt)
    || unit.revealedAt <= unit.registeredAt) throw new RangeError("feedback_report_close_order");

  return { unitId: unit.unitId, registeredAt: unit.registeredAt, revealedAt: unit.revealedAt };
}

/** S/F/N describe the fixed first-closing protocol report. Other and missing are not quality failures. */
export function estimateReportedFeedback(units: readonly ReportedFeedbackUnit[], delta: number): ReportedFeedbackEstimate {
  validateMeanDelta(delta);
  validateFeedbackPopulation(units);
  const layout = allocateRevealChains(units.map(reportOpportunity));
  const counts = { success: 0, failure: 0, closedOther: 0, pending: 0 };

  for (const unit of units) {
    if (unit.status === "other") counts.closedOther += 1;
    else counts[unit.status] += 1;
  }

  // |Y-half| <= half is declared before data. Raw V=n/4, normalized V=n.
  const summary = summarizeChainBoundaries({ chainCounts: layout.chainCounts, normalizedVariances: layout.chainCounts,
    delta, tailCount: 4, residualScale: 0.5 });
  let actualMeanSupport: ReportedMeanRanges | null = null;
  let conditionalMeanBands: ReportedMeanRanges | null = null;

  if (units.length > 0) {
    const common = { population: units.length, boundary: summary.totalBoundary };
    const success = projectBoundedMean({ ...common, lowerSum: counts.success, upperSum: counts.success + counts.pending });
    const failure = projectBoundedMean({ ...common, lowerSum: counts.failure, upperSum: counts.failure + counts.pending });

    actualMeanSupport = Object.freeze({ success: success.actualMeanSupport, failure: failure.actualMeanSupport,
      otherOrNever: Object.freeze([counts.closedOther / units.length, (counts.closedOther + counts.pending) / units.length]) as MeanInterval });
    conditionalMeanBands = Object.freeze({ success: success.conditionalMeanBand, failure: failure.conditionalMeanBand,
      otherOrNever: Object.freeze([Math.max(0, 1 - success.conditionalMeanBand[1] - failure.conditionalMeanBand[1]),
        Math.min(1, 1 - success.conditionalMeanBand[0] - failure.conditionalMeanBand[0])]) as MeanInterval });
  }

  return Object.freeze({ schemaVersion: 1, algorithm: "reported_sfn_eb_v1", status: units.length === 0 ? "no_data" : "estimated",
    target: "prefix_average_registration_observer_first_close_indicators", population: units.length, counts: Object.freeze(counts),
    chainCount: layout.chainCounts.length, residualScale: 0.5, centerRole: "predictable_nuisance_constant_half", delta,
    budgetRule: `${CHAIN_BUDGET_RULE}; S/F each two-sided, four tails`, coverageBasis: MEAN_COVERAGE_BASIS,
    interpretation: "reported_channel_only_not_task_quality_or_causal_credit", actualMeanSupport, conditionalMeanBands, ...summary });
}
