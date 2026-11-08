import { identity } from "../../../validation/json-shape.js";
import type { PredictionResult } from "./contracts.js";

export type BetaMoments = {
  readonly mean: number; readonly zeroProbability: number; readonly secondMoment: number;
  readonly variance: number; readonly expectedBernoulliVariance: number;
  readonly logMean: number; readonly logZeroProbability: number; readonly logSecondMoment: number;
  readonly logVariance: number; readonly logExpectedBernoulliVariance: number;
};

export type BetaGroupPrior = { readonly groupId: string; readonly alpha: number; readonly beta: number };

export type BetaGroupPosterior = BetaGroupPrior & { readonly positiveCount: number; readonly zeroCount: number };

function logProportion(numerator: number, other: number): number {
  return numerator >= other ? -Math.log1p(other / numerator)
    : Math.log(numerator) - Math.log(other) - Math.log1p(numerator / other);
}

/** Stable moments, without subtracting E[p²] - E[p]² or 1 - p. */
export function betaMoments(alpha: number, beta: number): PredictionResult<BetaMoments> {
  if (!Number.isFinite(alpha) || alpha <= 0 || !Number.isFinite(beta) || beta <= 0) {
    return { status: "invalid", reason: "prediction_beta_prior", detail: "Beta parameters must be finite and strictly positive." };
  }

  const total = alpha + beta;
  if (!Number.isFinite(total)) return { status: "unsupported", reason: "numeric_range", detail: "Beta concentration exceeds the numeric range." };

  const mean = alpha / total, zeroProbability = beta / total;
  const logMean = logProportion(alpha, beta), logZeroProbability = logProportion(beta, alpha);
  const logVariance = logMean + logZeroProbability - Math.log1p(total);
  const logExpectedBernoulliVariance = logMean + logZeroProbability + Math.log(total) - Math.log1p(total);
  const logSecondMoment = logMean + Math.log(alpha + 1) - Math.log(total + 1);

  return { status: "ready", value: { mean, zeroProbability, secondMoment: Math.exp(logSecondMoment),
    variance: Math.exp(logVariance), expectedBernoulliVariance: Math.exp(logExpectedBernoulliVariance),
    logMean, logZeroProbability, logSecondMoment, logVariance, logExpectedBernoulliVariance } };
}

/** Ordered Bernoulli facts have no binomial coefficient. Callers own fact identity validation. */
export function rebuildBetaGroups(priors: readonly BetaGroupPrior[], observations: readonly {
  readonly groupId: string; readonly outcome: 0 | 1;
}[]): PredictionResult<{ readonly groups: readonly BetaGroupPosterior[]; readonly logEvidence: number }> {
  const groups = new Map<string, { groupId: string; alpha: number; beta: number; positiveCount: number; zeroCount: number }>();

  for (const prior of priors) {
    if (!prior || !identity(prior.groupId) || groups.has(prior.groupId)) {
      return { status: "invalid", reason: "prediction_beta_group", detail: "Gate groups require unique nonempty identities." };
    }
    const checked = betaMoments(prior.alpha, prior.beta);
    if (checked.status !== "ready") return checked;
    groups.set(prior.groupId, { groupId: prior.groupId, alpha: prior.alpha, beta: prior.beta, positiveCount: 0, zeroCount: 0 });
  }

  let logEvidence = 0;

  for (const observation of observations) {
    const group = groups.get(observation.groupId);
    if (!group || (observation.outcome !== 0 && observation.outcome !== 1)) {
      return { status: "invalid", reason: "prediction_beta_group", detail: "Every known cost fact requires a declared gate prior." };
    }

    const moments = betaMoments(group.alpha, group.beta);
    if (moments.status !== "ready") return moments;

    logEvidence += observation.outcome === 1 ? moments.value.logMean : moments.value.logZeroProbability;

    if (observation.outcome === 1) {
      group.alpha += 1;
      group.positiveCount += 1;
    }
    else {
      group.beta += 1;
      group.zeroCount += 1;
    }

    const checked = betaMoments(group.alpha, group.beta);
    if (checked.status !== "ready") return checked;
  }

  if (!Number.isFinite(logEvidence)) return { status: "unsupported", reason: "numeric_range", detail: "Gate evidence exceeds the numeric range." };

  return { status: "ready", value: { groups: [...groups.values()], logEvidence } };
}
