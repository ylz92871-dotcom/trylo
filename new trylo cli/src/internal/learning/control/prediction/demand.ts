import { identity, sequence } from "../../../validation/json-shape.js";
import { betaMoments } from "./beta.js";
import type { PredictionResult } from "./contracts.js";

export type BetaBinomialDemandInput = {
  readonly targetKey: string; readonly referenceUnit: string; readonly sourceRef: string;
  readonly prior: { readonly alpha: number; readonly beta: number; readonly sourceRef: string };
  readonly n: number; readonly k: number; readonly horizon: number;
};

export type BetaBinomialDemandPrediction = BetaBinomialDemandInput & {
  readonly posteriorAlpha: number; readonly posteriorBeta: number;
  readonly rateMean: number; readonly rateVariance: number; readonly mean: number;
  readonly actualVariance: number; readonly meanDemandVariance: number; readonly expectedProcessVariance: number;
  readonly support: "prior-only" | "local-observations";
};

/** Counts refer to the caller's declared population, never implicit wall-clock demand. */
export function predictBetaBinomialDemand(input: BetaBinomialDemandInput): PredictionResult<BetaBinomialDemandPrediction> {
  if (!input || !identity(input.targetKey) || !identity(input.referenceUnit) || !identity(input.sourceRef)
    || !input.prior || !identity(input.prior.sourceRef) || !sequence(input.n) || !sequence(input.k)
    || input.k > input.n || !sequence(input.horizon)) {
    return { status: "invalid", reason: "prediction_demand_input", detail: "Demand requires bound provenance and valid integer trial, hit and horizon counts." };
  }

  const prior = betaMoments(input.prior.alpha, input.prior.beta);
  if (prior.status !== "ready") return prior;

  const posteriorAlpha = input.prior.alpha + input.k, posteriorBeta = input.prior.beta + (input.n - input.k);
  const posterior = betaMoments(posteriorAlpha, posteriorBeta);
  if (posterior.status !== "ready") return posterior;

  const moments = posterior.value;

  // Check after the actual count update: an extreme prior can become representable
  // after positive evidence. This API promises raw rate moments, not log moments.
  if (moments.mean === 0 || moments.variance === 0 || moments.expectedBernoulliVariance === 0) {
    return { status: "unsupported", reason: "numeric_range", detail: "A strictly positive posterior demand moment underflows the numeric range." };
  }

  const mean = input.horizon * moments.mean;
  const meanDemandVariance = input.horizon * (input.horizon * moments.variance);
  const expectedProcessVariance = input.horizon * moments.expectedBernoulliVariance;
  const actualVariance = meanDemandVariance + expectedProcessVariance;
  if (![mean, meanDemandVariance, expectedProcessVariance, actualVariance].every(Number.isFinite)
    || (input.horizon > 0 && [mean, meanDemandVariance, expectedProcessVariance, actualVariance].some(value => value === 0))) {
    return { status: "unsupported", reason: "numeric_range", detail: "Demand moments exceed or underflow the numeric range." };
  }

  return { status: "ready", value: { targetKey: input.targetKey, referenceUnit: input.referenceUnit, sourceRef: input.sourceRef,
    prior: { alpha: input.prior.alpha, beta: input.prior.beta, sourceRef: input.prior.sourceRef },
    n: input.n, k: input.k, horizon: input.horizon, posteriorAlpha, posteriorBeta,
    rateMean: moments.mean, rateVariance: moments.variance, mean, meanDemandVariance, expectedProcessVariance,
    actualVariance, support: input.n === 0 ? "prior-only" : "local-observations" } };
}
