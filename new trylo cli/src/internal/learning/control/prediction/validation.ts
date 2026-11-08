import type {GaussianLimits, NumericMatrix, NumericVector, PredictionFailure} from './contracts.js';

export function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isFiniteVector(value: unknown, expectedLength: number): value is NumericVector {
  if (!Array.isArray(value) || value.length !== expectedLength) return false;
  for (let index = 0; index < expectedLength; index++) {
    const entry: unknown = value[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return false;
  }
  return true;
}

export function isFiniteMatrix(value: unknown, rows: number, columns: number): value is NumericMatrix {
  if (!Array.isArray(value) || value.length !== rows) return false;
  for (let index = 0; index < rows; index++) {
    if (!isFiniteVector(value[index], columns)) return false;
  }
  return true;
}

export function validLimits(value: unknown): value is GaussianLimits {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'maxObservations' in value && isNonnegativeInteger(value.maxObservations)
    && 'maxLatentDimension' in value && isNonnegativeInteger(value.maxLatentDimension)
    && 'maxQueries' in value && isNonnegativeInteger(value.maxQueries)
    && 'maxComponents' in value && isNonnegativeInteger(value.maxComponents);
}

export function invalid(reason: string, detail: string): PredictionFailure {
  return {status: 'invalid', reason, detail};
}

export function unsupported(reason: string, detail: string): PredictionFailure {
  return {status: 'unsupported', reason, detail};
}
