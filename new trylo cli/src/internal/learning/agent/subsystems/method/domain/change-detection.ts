import { canonicalObservations, evidenceOf, type MethodObservation } from "./inference-observations.js";
import { logMarginalOf, type BinaryCounts } from "./inference.js";

/** A diagnostic model comparison, not an anytime false-alarm guarantee. The
 * alternatives describe one change within the observed window; they do not
 * establish its cause or invalidate a method without semantic review. */
export const METHOD_CHANGE_POLICY = Object.freeze({
  window: 24, minSegment: 3, changePrior: .1,
  changeThreshold: .8, declineThreshold: .9, minimumDecline: .1,
});

export type BayesianChangeSignal =
  | { readonly status: "insufficient"; readonly eligibleCount: number; readonly minimumCount: number }
  | {
      readonly status: "no_signal" | "reconsider";
      readonly eligibleCount: number;
      readonly observationIds: readonly string[];
      /** Mixture of all admissible splits, compared with a common-rate model. */
      readonly logBayesFactor: number;
      readonly changePosterior: number;
      /** P(rate_after < rate_before | data, a change), averaged over split uncertainty. */
      readonly declineProbability: number;
      readonly expectedDecline: number;
      readonly mostLikelySplit: { readonly beforeObservationId: string; readonly afterObservationId: string };
    };

type ScoredSplit = { readonly index: number; readonly before: BinaryCounts; readonly after: BinaryCounts; readonly logLikelihood: number };

/** Input must describe one version, report source and execution expression.
 * Known dependent origins and revisions are folded before the bounded window
 * is selected. A late correction keeps the original use order. */
export function changeDetectionOf(input: readonly MethodObservation[]): BayesianChangeSignal {
  const observations = changeCohort(input).slice(-METHOD_CHANGE_POLICY.window);
  const minimumCount = 2 * METHOD_CHANGE_POLICY.minSegment;
  if (observations.length < minimumCount) return { status: "insufficient", eligibleCount: observations.length, minimumCount };

  const total = countsOf(observations);
  const splits: ScoredSplit[] = [];
  let successesBefore = 0;

  for (let index = 1; index < observations.length; index += 1) {
    if (observations[index - 1]!.outcome === "helped") successesBefore += 1;
    if (index < METHOD_CHANGE_POLICY.minSegment || observations.length - index < METHOD_CHANGE_POLICY.minSegment) continue;
    const before = { successes: successesBefore, failures: index - successesBefore };
    const after = { successes: total.successes - before.successes, failures: total.failures - before.failures };
    splits.push({ index, before, after, logLikelihood: logMarginalOf(before) + logMarginalOf(after) });
  }

  return summarizeSplits(observations, total, splits);
}

function summarizeSplits(observations: readonly MethodObservation[], total: BinaryCounts,
  splits: readonly ScoredSplit[]): BayesianChangeSignal {
  const maximum = Math.max(...splits.map(split => split.logLikelihood));
  const normalizer = splits.reduce((sum, split) => sum + Math.exp(split.logLikelihood - maximum), 0);
  const logBayesFactor = maximum + Math.log(normalizer) - Math.log(splits.length) - logMarginalOf(total);
  const prior = METHOD_CHANGE_POLICY.changePrior;
  const changePosterior = logistic(Math.log(prior / (1 - prior)) + logBayesFactor);
  let declineProbability = 0, expectedDecline = 0;

  for (const split of splits) {
    const weight = Math.exp(split.logLikelihood - maximum) / normalizer;
    declineProbability += weight * lowerRateProbability(split.after, split.before);
    expectedDecline += weight * (predictiveMean(split.before) - predictiveMean(split.after));
  }

  const best = splits.reduce((left, right) => left.logLikelihood >= right.logLikelihood ? left : right);
  const reconsider = changePosterior >= METHOD_CHANGE_POLICY.changeThreshold &&
    declineProbability >= METHOD_CHANGE_POLICY.declineThreshold && expectedDecline >= METHOD_CHANGE_POLICY.minimumDecline;

  return { status: reconsider ? "reconsider" : "no_signal", eligibleCount: observations.length,
    observationIds: observations.map(item => item.observationId), logBayesFactor, changePosterior,
    declineProbability: clampProbability(declineProbability), expectedDecline,
    mostLikelySplit: { beforeObservationId: observations[best.index - 1]!.observationId,
      afterObservationId: observations[best.index]!.observationId } };
}

function changeCohort(input: readonly MethodObservation[]): readonly MethodObservation[] {
  const canonical = canonicalObservations(input);
  const first = canonical[0];
  if (first === undefined) return [];

  if (canonical.some(item => item.versionId !== first.versionId || item.source !== first.source ||
    item.compilationId !== first.compilationId)) throw new RangeError("mixed_change_detection_cohort");

  return evidenceOf(canonical, { versionId: first.versionId, source: first.source,
    executionBasis: first.compilationId === undefined ? { kind: "source" } :
      { kind: "compilation", compilationId: first.compilationId } }).observations;
}

/** For independent posteriors L~Beta(1+sL,1+fL), R~Beta(1+sR,1+fR),
 * P(L<R) = E_R[I_R(aL,bL)]. Expand the integer-Beta CDF as a binomial
 * tail and integrate each positive term. This avoids subtracting near-one
 * probabilities or numerical quadrature. Window bounds keep the sum small. */
function lowerRateProbability(left: BinaryCounts, right: BinaryCounts): number {
  const alphaLeft = left.successes + 1;
  const n = left.successes + left.failures + 1;
  const denominator = logMarginalOf(right);
  let logChoose = 0, probability = 0;

  for (let index = 0; index <= n; index += 1) {
    if (index > 0) logChoose += Math.log((n - index + 1) / index);
    if (index < alphaLeft) continue;
    probability += Math.exp(logChoose + logMarginalOf({ successes: right.successes + index,
      failures: right.failures + n - index }) - denominator);
  }

  return clampProbability(probability);
}

function countsOf(observations: readonly MethodObservation[]): BinaryCounts {
  const successes = observations.filter(item => item.outcome === "helped").length;
  return { successes, failures: observations.length - successes };
}

function predictiveMean(counts: BinaryCounts): number {
  return (counts.successes + 1) / (counts.successes + counts.failures + 2);
}

function logistic(logOdds: number): number {
  return logOdds >= 0 ? 1 / (1 + Math.exp(-logOdds)) : Math.exp(logOdds) / (1 + Math.exp(logOdds));
}

function clampProbability(value: number): number { return Math.max(0, Math.min(1, value)); }
