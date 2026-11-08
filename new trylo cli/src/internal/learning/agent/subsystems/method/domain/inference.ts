import { evidenceOf, type EvidenceSelection, type MethodObservation } from "./inference-observations.js";

export { isMethodObservation, type MethodObservation } from "./inference-observations.js";

/** Engineering thresholds; none is a frequency-uniform error guarantee. */
export const METHOD_INFERENCE_POLICY = Object.freeze({
  priorAlpha: 1, priorBeta: 1, target: .75, algorithmThreshold: .95, modelThreshold: .8,
  exitWindow: 12, exitMinEvidence: 6, exitTarget: .5, exitThreshold: .9,
});

export type BinaryCounts = { readonly successes: number; readonly failures: number };

export type BetaPosterior = BinaryCounts & {
  readonly alpha: number;
  readonly beta: number;
  readonly mean: number;
  readonly target: number;
  readonly confidence: number;
};

export function posteriorOf(counts: BinaryCounts, options: {
  readonly priorAlpha?: number; readonly priorBeta?: number; readonly target?: number;
} = {}): BetaPosterior {
  requireCount(counts.successes);
  requireCount(counts.failures);
  const priorAlpha = options.priorAlpha ?? METHOD_INFERENCE_POLICY.priorAlpha;
  const priorBeta = options.priorBeta ?? METHOD_INFERENCE_POLICY.priorBeta;

  requirePositiveInteger(priorAlpha);
  requirePositiveInteger(priorBeta);
  const alpha = priorAlpha + counts.successes;
  const beta = priorBeta + counts.failures;
  const target = options.target ?? METHOD_INFERENCE_POLICY.target;

  return { ...counts, alpha, beta, mean: alpha / (alpha + beta), target,
    confidence: betaSurvival(alpha, beta, target) };
}

/**
 * Integer-Beta survival equals Binomial(alpha+beta-1, target)'s CDF at alpha-1.
 * Recurrences start at the binomial mode, using relative weights (mode=1).
 * This avoids factorial overflow and cancellation of a tiny survival from 1.
 * The two omitted tails are bounded by decreasing geometric series, each below
 * 2e-16 relative to the mode. No third-party implementation is copied.
 */
export function betaSurvival(alpha: number, beta: number, target: number): number {
  requirePositiveInteger(alpha);
  requirePositiveInteger(beta);

  if (!Number.isFinite(target) || target < 0 || target > 1) throw new RangeError("invalid_probability");

  if (target === 0) return 1;

  if (target === 1) return 0;

  const n = alpha + beta - 1;
  if (!Number.isSafeInteger(n) || n > 100_000_000) throw new RangeError("inference_count_limit");

  const mode = Math.min(n, Math.floor((n + 1) * target));
  const cutoff = alpha - 1;
  let total = 1;
  let lower = mode <= cutoff ? 1 : 0;

  for (const direction of [-1, 1]) {
    let index = mode;
    let weight = 1;

    while (direction < 0 ? index > 0 : index < n) {
      const ratio = direction < 0 ? index / (n - index + 1) * (1 - target) / target :
        (n - index) / (index + 1) * target / (1 - target);

      weight *= ratio;
      index += direction;
      total += weight;

      if (index <= cutoff) lower += weight;

      const nextRatio = direction < 0 ? index / (n - index + 1) * (1 - target) / target :
        (n - index) / (index + 1) * target / (1 - target);
      if (nextRatio < 1 && weight * nextRatio / (1 - nextRatio) < 2e-16) break;
    }
  }

  return Math.max(0, Math.min(1, lower / total));
}

export function recentPosteriorOf(input: ReadonlyArray<MethodObservation>, selection: EvidenceSelection): {
  readonly posterior: BetaPosterior; readonly eligibleCount: number; readonly failureConfidence: number;
  readonly shouldExit: boolean;
} {
  const selected = evidenceOf(input, selection).observations.slice(-METHOD_INFERENCE_POLICY.exitWindow);
  const successes = selected.filter(item => item.outcome === "helped").length;
  const failures = selected.length - successes;
  const posterior = posteriorOf({ successes, failures }, { target: METHOD_INFERENCE_POLICY.exitTarget });
  const failureConfidence = betaSurvival(posterior.beta, posterior.alpha, 1 - METHOD_INFERENCE_POLICY.exitTarget);

  return { posterior, eligibleCount: selected.length, failureConfidence,
    shouldExit: selected.length >= METHOD_INFERENCE_POLICY.exitMinEvidence &&
      failureConfidence >= METHOD_INFERENCE_POLICY.exitThreshold };
}

/** Log probability of a particular ordered Bernoulli sequence, integrated over Beta(1,1). */
export function logMarginalOf(counts: BinaryCounts): number {
  requireCount(counts.successes);
  requireCount(counts.failures);
  const n = counts.successes + counts.failures;
  const smaller = Math.min(counts.successes, counts.failures);
  let logChoose = 0;

  for (let index = 1; index <= smaller; index += 1) logChoose += Math.log((n - smaller + index) / index);

  return -Math.log(n + 1) - logChoose;
}

function requireCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid_count");
}

function requirePositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("invalid_beta_parameter");
}
