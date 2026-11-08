import { logMarginalOf, type BinaryCounts } from "./inference.js";

/** A paid-review scheduling threshold, not a promotion or correctness gate. */
export const METHOD_REVIEW_INFORMATION_POLICY = Object.freeze({ minimumDivergence: .1 });

export type ReviewInformation = {
  /** KL(current posterior || previously deferred posterior), in nats. */
  readonly divergence: number;
  readonly sufficient: boolean;
};

/** Callers supply counts from the same version, registered scope, report
 * source and qualification epoch. Counterexamples, corrections, blocks and
 * newly qualified hypotheses have separate immediate review paths.
 * No source/compiled evidence or unrelated epochs may be compared here. */
export function reviewInformationOf(previous: BinaryCounts, current: BinaryCounts,
  minimumDivergence = METHOD_REVIEW_INFORMATION_POLICY.minimumDivergence): ReviewInformation {
  requireCounts(previous);
  requireCounts(current);

  if (!Number.isFinite(minimumDivergence) || minimumDivergence <= 0) throw new RangeError("invalid_review_information_threshold");

  if (previous.successes === current.successes && previous.failures === current.failures) return { divergence: 0, sufficient: false };

  let divergence: number;

  if (previous.failures === 0 && current.failures === 0) {
    divergence = boundaryDivergence(previous.successes + 1, current.successes + 1);
  } else if (previous.successes === 0 && current.successes === 0) {
    divergence = boundaryDivergence(previous.failures + 1, current.failures + 1);
  } else {
    const alpha = current.successes + 1, beta = current.failures + 1;
    const successesAdded = current.successes - previous.successes;
    const failuresAdded = current.failures - previous.failures;

    divergence = logMarginalOf(previous) - logMarginalOf(current);

    // psi(a+b)-psi(a) is a finite positive harmonic sum for integer a,b.
    // Gamma's constant cancels, avoiding two large harmonic numbers.
    if (successesAdded !== 0) divergence -= successesAdded * harmonicDifference(alpha, alpha + beta);

    if (failuresAdded !== 0) divergence -= failuresAdded * harmonicDifference(beta, alpha + beta);
  }

  // KL is nonnegative analytically; tiny negative rounding cannot buy a review.
  divergence = Math.max(0, divergence);

  return { divergence, sufficient: divergence >= minimumDivergence };
}

/** KL(Beta(a,1)||Beta(a0,1)); the Beta(1,b) case is symmetric. */
function boundaryDivergence(previous: number, current: number): number {
  const difference = current - previous;
  return Math.log1p(difference / previous) - difference / current;
}

/** Sum 1/k over [start,end). Bounded ledger counts bound this work; the
 * scheduling contact does not scan hypothetical or generated observations. */
function harmonicDifference(start: number, end: number): number {
  let sum = 0, compensation = 0;

  for (let index = start; index < end; index += 1) {
    const term = 1 / index - compensation;
    const next = sum + term;
    compensation = (next - sum) - term;
    sum = next;
  }

  return sum;
}

function requireCounts(counts: BinaryCounts): void {
  if (!Number.isSafeInteger(counts.successes) || counts.successes < 0 ||
    !Number.isSafeInteger(counts.failures) || counts.failures < 0 ||
    !Number.isSafeInteger(counts.successes + counts.failures + 2)) throw new RangeError("invalid_review_information_counts");
}
