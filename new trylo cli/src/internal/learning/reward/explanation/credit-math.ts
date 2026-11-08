/** Canonical AIPW arithmetic only. Population, actual randomization and frozen inputs are caller contracts. */
export interface CreditParameters {
  readonly actionProbability: number;
  readonly referenceProbability: number;
  readonly actionPrediction: number;
  readonly referencePrediction: number;
}

export type CreditRole = "action" | "reference" | "other";

export interface CreditScoreInterval { readonly lower: number; readonly upper: number }

export interface CreditResidualInterval {
  readonly normalizedLower: number;
  readonly normalizedUpper: number;
  readonly normalizedVarianceUpper: number;
}

export interface CreditProjectionInput {
  readonly count: number;
  readonly normalizedLowerSum: number;
  readonly normalizedUpperSum: number;
  readonly normalizedBoundary: number;
  readonly minimumPropensity: number;
  readonly observedContrast: number;
}

export type CreditBandReason = "no_observed_contrast_outcomes" | "range_intersection_empty" | "full_range_band" | null;

function checkParameters(p: CreditParameters): void {
  const probabilities = [p.actionProbability, p.referenceProbability];
  const predictions = [p.actionPrediction, p.referencePrediction];
  if (probabilities.some(value => !Number.isFinite(value) || value <= 0 || value > 1)
    || predictions.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RangeError("invalid_credit_math_parameters");
  }
}

function checkOutcome(value: number | null): void {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RangeError("invalid_credit_math_outcome");
  }
}

function indicators(role: CreditRole): readonly [number, number] {
  if (role === "action") return [1, 0];
  if (role === "reference") return [0, 1];
  if (role === "other") return [0, 0];
  throw new RangeError("invalid_credit_math_role");
}

export function creditSupport(p: CreditParameters) {
  checkParameters(p);
  const pa = p.actionProbability, pb = p.referenceProbability;
  const ma = p.actionPrediction, mb = p.referencePrediction, d = ma - mb;
  const below = Math.max(ma / pa, (1 - mb) / pb);
  const above = Math.max((1 - ma) / pa, mb / pb);
  const supportWidth = below + above;

  return Object.freeze({ scoreRange: [d - below, d + above] as const, supportWidth,
    coarseWidth: 1 / pa + 1 / pb, varianceIncrement: supportWidth ** 2 / 4 });
}

/** Preserve the original operation order, including direct terms for all other selected arms. */
export function creditScore(p: CreditParameters, role: CreditRole, value: number | null): CreditScoreInterval {
  checkParameters(p);
  checkOutcome(value);
  const [ia, ib] = indicators(role);
  const pa = p.actionProbability, pb = p.referenceProbability;
  const ma = p.actionPrediction, mb = p.referencePrediction, d = ma - mb;

  if (value !== null) {
    const score = d + ia * (value - ma) / pa - ib * (value - mb) / pb;
    return Object.freeze({ lower: score, upper: score });
  }

  return Object.freeze({ lower: d - ia * ma / pa - ib * (1 - mb) / pb,
    upper: d + ia * (1 - ma) / pa + ib * mb / pb });
}

/** Normalize before inverse-propensity scaling or squaring; the declared floor is fixed by the design. */
export function creditResidual(p: CreditParameters, role: CreditRole, value: number | null,
  minimumPropensity: number): CreditResidualInterval {
  checkParameters(p);
  checkOutcome(value);

  if (!Number.isFinite(minimumPropensity) || minimumPropensity <= 0 || minimumPropensity > .5
    || p.actionProbability < minimumPropensity || p.referenceProbability < minimumPropensity) {
    throw new RangeError("invalid_credit_residual_support");
  }

  const [ia, ib] = indicators(role), lo = value ?? 0, hi = value ?? 1;
  const ma = p.actionPrediction, mb = p.referencePrediction;
  const ra = minimumPropensity / p.actionProbability, rb = minimumPropensity / p.referenceProbability;
  const lower = ia * ra * (lo - ma) - ib * rb * (hi - mb);
  const upper = ia * ra * (hi - ma) - ib * rb * (lo - mb);
  const center = minimumPropensity * (ma - mb);

  return Object.freeze({ normalizedLower: center + lower, normalizedUpper: center + upper,
    normalizedVarianceUpper: Math.max(lower ** 2, upper ** 2) });
}

/** Only target-support intersection belongs here; the boundary itself is shared with noncausal means. */
export function projectResidualCredit(input: CreditProjectionInput) {
  const { count, normalizedLowerSum, normalizedUpperSum, normalizedBoundary, minimumPropensity, observedContrast } = input;

  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(observedContrast)
    || observedContrast < 0 || observedContrast > count || !Number.isFinite(minimumPropensity)
    || minimumPropensity <= 0 || minimumPropensity > .5 || normalizedBoundary < 0
    || ![normalizedLowerSum, normalizedUpperSum, normalizedBoundary].every(Number.isFinite)
    || normalizedLowerSum > normalizedUpperSum) throw new RangeError("invalid_credit_projection");

  const scale = 1 / minimumPropensity, boundary = normalizedBoundary * scale, radius = boundary / count;
  const lower = normalizedLowerSum / count, upper = normalizedUpperSum / count;
  const rawLower = lower - normalizedBoundary / count, rawUpper = upper + normalizedBoundary / count;
  const rawBand = [rawLower * scale, rawUpper * scale] as const;
  const band = [Math.max(-minimumPropensity, rawLower) / minimumPropensity,
    Math.min(minimumPropensity, rawUpper) / minimumPropensity] as const;
  if (![scale, boundary, radius, ...rawBand, ...band].every(Number.isFinite)) {
    throw new RangeError("credit_projection_numeric_range");
  }

  const reason: CreditBandReason = observedContrast === 0 ? "no_observed_contrast_outcomes"
    : band[0] > band[1] ? "range_intersection_empty"
      : band[0] === -1 && band[1] === 1 ? "full_range_band" : null;

  return Object.freeze({ boundary, radius, rawBand, reason,
    scoreMeanRange: [lower * scale, upper * scale] as const,
    confidenceBand: reason ? [-1, 1] as const : band });
}
