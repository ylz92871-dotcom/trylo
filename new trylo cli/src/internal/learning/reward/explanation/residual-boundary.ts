/** Fixed countable EB lines. Callers own support, predictability, targets and error allocation. */
export interface ResidualBoundaryInput {
  readonly count: number;
  readonly normalizedVariance: number;
  readonly logInverseTailBudget: number;
}

export interface ResidualBoundaryResult {
  readonly normalizedBoundary: number;
  readonly gridIndex: number;
  readonly algorithm: "countable_eb_v1";
}

export interface CompensatedSum {
  readonly value: number;
  readonly error: number;
}

export function emptySum(): CompensatedSum {
  return Object.freeze({ value: 0, error: 0 });
}

/** Same compensated addition as the original credit kernel; never mutates a prior state. */
export function addToSum(sum: CompensatedSum, increment: number): CompensatedSum {
  if (![sum.value, sum.error, increment].every(Number.isFinite)) {
    throw new RangeError("residual_sum_numeric_range");
  }

  const adjusted = increment - sum.error;
  const value = sum.value + adjusted;
  const error = (value - sum.value) - adjusted;
  if (![value, error].every(Number.isFinite)) throw new RangeError("residual_sum_numeric_range");

  return Object.freeze({ value, error });
}

/** Positive series plus a real-arithmetic upper remainder; ordinary double is not directed rounding. */
function psiOverEta(eta: number): number {
  let total = 0, power = eta;
  const terms = 32;

  for (let index = 1; index <= terms; index++) {
    total += power / (index + 1);
    power *= eta;
  }

  return total + power / ((terms + 2) * (1 - eta));
}

export function residualBoundary(input: ResidualBoundaryInput): ResidualBoundaryResult {
  const { count, normalizedVariance, logInverseTailBudget } = input;

  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(normalizedVariance)
    || normalizedVariance < 0 || normalizedVariance > count
    || !Number.isFinite(logInverseTailBudget) || logInverseTailBudget <= 0) {
    throw new RangeError("invalid_residual_boundary_input");
  }

  let normalizedBoundary = Infinity, gridIndex = 0;
  const last = Math.ceil(Math.log2(count));

  for (let index = 0; index <= last; index++) {
    const eta = 2 ** (-index - 1);
    // w_j=1/((j+1)(j+2)); the caller has already allocated side/chain/component budgets.
    const threshold = logInverseTailBudget + Math.log(index + 1) + Math.log(index + 2);
    const candidate = threshold / eta + psiOverEta(eta) * normalizedVariance;
    if (!Number.isFinite(candidate)) throw new RangeError("residual_boundary_numeric_range");
    if (candidate < normalizedBoundary) {
      normalizedBoundary = candidate;
      gridIndex = index;
    }
  }

  return Object.freeze({ normalizedBoundary, gridIndex, algorithm: "countable_eb_v1" });
}
