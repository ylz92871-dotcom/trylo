import { identity } from "../../../validation/json-shape.js";
import type { PredictionResult } from "./contracts.js";

export type ExpectedNeedGainInput = {
  readonly targetKey: string; readonly sourceRef: string; readonly horizon: number;
  readonly needMean: number; readonly gainMean: number; readonly gainLower: number; readonly gainUpper: number;
};

export type ExpectedNeedGainBounds = {
  readonly targetKey: string; readonly sourceRef: string; readonly lower: number; readonly upper: number;
  readonly interpretation: "support-and-marginal-mean-identification-bounds"; readonly joint: "unspecified";
};

/** Sharp bounds over all couplings with the supplied support and marginal means. H may be real. */
export function boundExpectedNeedGain(input: ExpectedNeedGainInput): PredictionResult<ExpectedNeedGainBounds> {
  if (!input || !identity(input.targetKey) || !identity(input.sourceRef)
    || !Number.isFinite(input.horizon) || input.horizon < 0 || !Number.isFinite(input.needMean)
    || input.needMean < 0 || input.needMean > input.horizon || !Number.isFinite(input.gainMean)) {
    return { status: "invalid", reason: "prediction_dependence_input", detail: "Need requires a finite nonnegative upper bound and a compatible mean." };
  }

  if (!Number.isFinite(input.gainLower) || !Number.isFinite(input.gainUpper)) {
    return { status: "unsupported", reason: "prediction_dependence_support", detail: "This bound requires finite hard gain support, not a posterior interval." };
  }

  if (input.gainUpper < input.gainLower || input.gainMean < input.gainLower || input.gainMean > input.gainUpper) {
    return { status: "invalid", reason: "prediction_dependence_input", detail: "Gain support and mean are inconsistent." };
  }

  const { horizon, needMean, gainMean, gainLower, gainUpper } = input;
  let lower: number, upper: number;

  if (horizon === 0) {
    lower = 0;
    upper = 0;
  }
  else if (gainUpper === gainLower) {
    lower = gainLower * needMean;
    upper = lower;
  }
  else {
    const width = gainUpper - gainLower, p = needMean / horizon, q = (gainMean - gainLower) / width;
    if (!Number.isFinite(width)) return { status: "unsupported", reason: "numeric_range", detail: "Gain support width exceeds the numeric range." };
    // Multiplying normalized mass by H first avoids an unnecessary H*(U-L) overflow.
    lower = gainLower * needMean + width * (horizon * Math.max(0, p + q - 1));
    upper = gainLower * needMean + width * (horizon * Math.min(p, q));
  }

  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    return { status: "unsupported", reason: "numeric_range", detail: "Product expectation bounds exceed the numeric range." };
  }

  return { status: "ready", value: { targetKey: input.targetKey, sourceRef: input.sourceRef, lower, upper,
    interpretation: "support-and-marginal-mean-identification-bounds", joint: "unspecified" } };
}
