import { addToSum, emptySum, residualBoundary } from "./residual-boundary.js";

export type MeanInterval = readonly [number, number];

export type ChainBoundarySummary = {
  readonly ordinal: number;
  readonly count: number;
  readonly normalizedVariance: number;
  readonly boundary: number;
  readonly gridIndex: number;
  readonly logInverseTailBudget: number;
};

export const MEAN_COVERAGE_BASIS = "conditional_on_fixed_stream_observer_reliable_reveals_and_supports";
export const CHAIN_BUDGET_RULE = "delta_r=delta/[r(r+1)]; fixed countable grid; no renormalization";

export function validateMeanDelta(delta: number): void {
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) throw new RangeError("feedback_delta");
}

export function summarizeChainBoundaries(input: {
  readonly chainCounts: readonly number[];
  readonly normalizedVariances: readonly number[];
  readonly delta: number;
  readonly tailCount: 2 | 4;
  readonly residualScale: number;
}): { readonly chains: readonly ChainBoundarySummary[]; readonly totalBoundary: number } {
  validateMeanDelta(input.delta);

  if (input.chainCounts.length !== input.normalizedVariances.length || !Number.isFinite(input.residualScale)
    || input.residualScale <= 0) throw new RangeError("feedback_chain_statistics_shape");

  let total = emptySum();
  const chains = input.chainCounts.map((count, index) => {
    const ordinal = index + 1;
    // Do not multiply tiny probabilities: even a legal positive delta can underflow when split.
    const logInverseTailBudget = Math.log(input.tailCount) - Math.log(input.delta) + Math.log(ordinal) + Math.log(ordinal + 1);
    const normalizedVariance = input.normalizedVariances[index]!;
    const bound = residualBoundary({ count, normalizedVariance, logInverseTailBudget });
    const boundary = bound.normalizedBoundary * input.residualScale;

    total = addToSum(total, boundary);

    return Object.freeze({ ordinal, count, normalizedVariance, boundary, gridIndex: bound.gridIndex, logInverseTailBudget });
  });

  return Object.freeze({ chains: Object.freeze(chains), totalBoundary: total.value });
}

/** Actual result support and conditional expectation are different objects; never intersect them. */
export function projectBoundedMean(input: {
  readonly population: number;
  readonly lowerSum: number;
  readonly upperSum: number;
  readonly boundary: number;
}): { readonly actualMeanSupport: MeanInterval; readonly conditionalMeanBand: MeanInterval; readonly rawBand: MeanInterval } {
  const { population, lowerSum, upperSum, boundary } = input;

  if (!Number.isSafeInteger(population) || population <= 0 || ![lowerSum, upperSum, boundary].every(Number.isFinite)
    || lowerSum < 0 || upperSum < lowerSum || upperSum > population || boundary < 0) {
    throw new RangeError("feedback_mean_statistics");
  }

  const rawBand: MeanInterval = Object.freeze([(lowerSum - boundary) / population, (upperSum + boundary) / population]);
  if (!rawBand.every(Number.isFinite)) throw new RangeError("feedback_mean_numeric_range");

  return Object.freeze({ actualMeanSupport: Object.freeze([lowerSum / population, upperSum / population]) as MeanInterval,
    conditionalMeanBand: Object.freeze([Math.max(0, rawBand[0]), Math.min(1, rawBand[1])]) as MeanInterval, rawBand });
}
