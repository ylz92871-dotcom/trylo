import type { NumericMatrix, NumericVector, PredictionResult } from "./contracts.js";
import type { ResponseCoordinates, ResponsePrior } from "./response-contracts.js";
import { factorRank } from "./response-validation.js";

export interface ResponseDesign {
  readonly dimension: number;
  readonly offsets: NumericVector;
  readonly factors: NumericMatrix;
  readonly independentFactors: NumericMatrix;
}

function project(features: NumericVector, factor: NumericMatrix, rank: number): number[] {
  return Array.from({ length: rank }, (_, column) => features.reduce((sum, item, row) => sum + item * factor[row]![column]!, 0));
}

/** Known and new group columns are each shared across all rows in this query. */
export function responseDesign(rows: readonly ResponseCoordinates[], prior: ResponsePrior,
  knownGroups: readonly string[], newGroups: readonly string[], maximumDimension: number): PredictionResult<ResponseDesign> {
  const sharedRank = factorRank(prior.sharedFactor, prior.sharedMean.length)!;
  const localRank = factorRank(prior.localFactor, prior.localFactor.length)!;
  const dimension = sharedRank + knownGroups.length * localRank;
  const independentDimension = newGroups.length * localRank;
  if (!Number.isSafeInteger(dimension + independentDimension) || dimension + independentDimension > maximumDimension) {
    return { status: "unsupported", reason: "capacity_exceeded", detail: "Response latent columns exceed declared capacity" };
  }

  const known = new Map(knownGroups.map((group, index) => [group, index]));
  const fresh = new Map(newGroups.map((group, index) => [group, index]));
  const offsets: number[] = [];
  const factors: number[][] = [];
  const independentFactors: number[][] = [];

  for (const row of rows) {
    const offset = row.sharedFeatures.reduce((sum, item, index) => sum + item * prior.sharedMean[index]!, 0);
    const loading = Array<number>(dimension).fill(0);
    const independent = Array<number>(independentDimension).fill(0);
    const shared = project(row.sharedFeatures, prior.sharedFactor, sharedRank);
    const local = project(row.localFeatures, prior.localFactor, localRank);

    shared.forEach((value, column) => { loading[column] = value; });
    const oldIndex = known.get(row.group);
    const newIndex = fresh.get(row.group);

    local.forEach((value, column) => {
      if (oldIndex !== undefined) loading[sharedRank + oldIndex * localRank + column] = value;
      else if (newIndex !== undefined) independent[newIndex * localRank + column] = value;
    });

    if (!Number.isFinite(offset) || [...loading, ...independent].some(value => !Number.isFinite(value))) {
      return { status: "unsupported", reason: "numeric_range", detail: "Response factor construction exceeds finite arithmetic" };
    }

    offsets.push(offset);
    factors.push(loading);
    independentFactors.push(independent);
  }

  return { status: "ready", value: { dimension, offsets, factors, independentFactors } };
}

export function copyResponsePrior(prior: ResponsePrior, logPriorWeight: number): ResponsePrior {
  const copyMatrix = (matrix: NumericMatrix) => Object.freeze(matrix.map(row => Object.freeze([...row])));
  return Object.freeze({ id: prior.id, logPriorWeight, sourceRef: prior.sourceRef, noiseSourceRef: prior.noiseSourceRef,
    sharedMean: Object.freeze([...prior.sharedMean]), sharedFactor: copyMatrix(prior.sharedFactor), localFactor: copyMatrix(prior.localFactor) });
}
