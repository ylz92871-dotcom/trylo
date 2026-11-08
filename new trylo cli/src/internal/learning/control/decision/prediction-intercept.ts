import { addToSum, emptySum } from "../../reward/explanation/residual-boundary.js";
import { contentHashOf } from "../hash.js";
import type { PredictionResult } from "../prediction/contracts.js";
import type { ResponseObservation } from "../prediction/response-contracts.js";

export const CENTRAL_RESPONSE_KERNEL_MAX_OBSERVATIONS = 512;

export type CentralInterceptEvidence = { readonly observations: readonly ResponseObservation[]; readonly noise: readonly (readonly number[])[];
  readonly reduction: "no_observations" | "one_exact_intercept_mean"; readonly fullObservationCount: number };

/** Canonical same-class scalar observations with one fixed noise R. Large raw
 * history is not a reason to enlarge the dense Gaussian work budget. For this
 * single intercept, ybar with noise R/n has exactly the same parameter posterior.
 * Its marginal density is not the complete-data likelihood/evidence. */
export function buildCentralInterceptEvidence(rows: readonly ResponseObservation[], noiseVariance: number,
  maxObservations: number): PredictionResult<CentralInterceptEvidence> {
  if (!Array.isArray(rows) || !Number.isFinite(noiseVariance) || noiseVariance <= 0 || !Number.isSafeInteger(maxObservations)
    || maxObservations < 0 || maxObservations > CENTRAL_RESPONSE_KERNEL_MAX_OBSERVATIONS
    || !rows.every(row => Number.isFinite(row.value) && Array.isArray(row.sharedFeatures) && row.sharedFeatures.length === 1
      && row.sharedFeatures[0] === 1 && Array.isArray(row.localFeatures) && row.localFeatures.length === 0
      && row.group === rows[0]!.group && row.targetKey === rows[0]!.targetKey && row.featureMapKey === rows[0]!.featureMapKey)) {
    return { status: "invalid", reason: "central_intercept_evidence_input", detail: "Expected one canonical intercept class, fixed positive R and bounded kernel capacity" };
  }

  if (rows.length === 0) return { status: "ready", value: { observations: rows, noise: [],
    reduction: "no_observations", fullObservationCount: 0 } };

  if (maxObservations === 0) return { status: "unsupported", reason: "capacity_exceeded", detail: "A populated class requires at least one Gaussian observation slot" };

  const reducedNoise = noiseVariance / rows.length;
  if (!(reducedNoise > 0) || !Number.isFinite(reducedNoise)) return { status: "unsupported", reason: "central_intercept_noise_underflow",
    detail: "R/n cannot be represented as strictly positive noise; no jitter or zero-noise substitution is permitted" };

  let sum = emptySum();

  try { for (const row of rows) sum = addToSum(sum, row.value); }
  catch (error) {
    if (error instanceof RangeError && error.message === "residual_sum_numeric_range") return {
      status: "unsupported", reason: "central_intercept_mean_numeric_range", detail: "The exact-class observation sum exceeds numeric capacity" };
    throw error;
  }

  const mean = sum.value / rows.length;
  if (!Number.isFinite(mean) || sum.value !== 0 && mean === 0) return { status: "unsupported", reason: "central_intercept_mean_numeric_range",
    detail: "The observation mean cannot be represented without a spurious zero" };

  const aggregate = `response-sufficient-mean:${contentHashOf(rows)}`;

  return { status: "ready", value: { observations: [{ ...rows[0]!, id: aggregate, revisionRef: aggregate, sourceRef: aggregate,
    instanceRef: aggregate, baselineRef: aggregate, value: mean }], noise: [[reducedNoise]],
    reduction: "one_exact_intercept_mean", fullObservationCount: rows.length } };
}
