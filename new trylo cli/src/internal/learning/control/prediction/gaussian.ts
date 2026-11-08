import type {
  GaussianFit, GaussianFitInput, GaussianPrediction, GaussianQueryInput,
  PredictionFailure, PredictionResult,
} from './contracts.js';
import {
  cholesky, dot, gram, logAbsDiagonal, numeric, PredictionNumericalError,
  rightSolve, solveUpper, squaredNorm, stableSum, triangularize, whitenRows,
} from './linear-algebra.js';
import {invalid, isFiniteMatrix, isFiniteVector, isNonnegativeInteger, unsupported, validLimits} from './validation.js';

function fitFailure(input: GaussianFitInput): PredictionFailure | undefined {
  if (input === null || typeof input !== 'object' || !validLimits(input.limits)
    || !isNonnegativeInteger(input.latentDimension) || !Array.isArray(input.observations)) {
    return invalid('shape', 'Gaussian fit requires explicit dimensions, observations and limits');
  }

  const count = input.observations.length;
  const dimension = input.latentDimension;
  if (count > input.limits.maxObservations || dimension > input.limits.maxLatentDimension
    || input.limits.maxComponents < 1 || !Number.isSafeInteger((count + dimension) * (dimension + 1))) {
    return unsupported('capacity', 'Gaussian fit exceeds the declared engineering limits');
  }

  if (!isFiniteVector(input.observations, count) || !isFiniteVector(input.observationOffsets, count)
    || !isFiniteMatrix(input.observationFactors, count, dimension) || !isFiniteMatrix(input.noise, count, count)) {
    return invalid('shape', 'Gaussian fit arrays must be finite and match n and latentDimension');
  }

  for (let row = 0; row < count; row++) {
    for (let column = 0; column < row; column++) {
      if (input.noise[row]![column] !== input.noise[column]![row]) {
        return invalid('noise_asymmetric', 'Observation covariance must be exactly symmetric');
      }
    }
  }

  return undefined;
}

function fitComponent(input: GaussianFitInput): GaussianFit {
  const dimension = input.latentDimension;
  const count = input.observations.length;
  const lower = cholesky(input.noise);
  const rows = input.observations.map((value, index) => [
    ...input.observationFactors[index]!,
    numeric(value - input.observationOffsets[index]!, 'observation centering'),
  ]);
  const whitened = whitenRows(lower, rows, dimension + 1);
  // I is the declared standard-normal latent prior, never numerical jitter.
  const augmented: number[][] = Array.from({length: dimension}, (_, row) =>
    Array.from({length: dimension + 1}, (_, column) => row === column ? 1 : 0));

  for (const row of whitened) augmented.push(row);

  triangularize(augmented, dimension);
  const upper = augmented.slice(0, dimension).map(row => row.slice(0, dimension));
  const rhs = augmented.slice(0, dimension).map(row => row[dimension]!);
  const residualSquare = squaredNorm(augmented.slice(dimension).map(row => row[dimension]!));
  const logEvidence = count === 0 ? 0 : numeric(-0.5 * stableSum([
    count * Math.log(2 * Math.PI), 2 * logAbsDiagonal(lower),
    2 * logAbsDiagonal(upper), residualSquare,
  ], 'Gaussian evidence'), 'Gaussian evidence');

  return {
    latentDimension: dimension, observationCount: count,
    upper, latentMean: solveUpper(upper, rhs), logEvidence,
  };
}

/** Full known-SPD observation noise; rectangular prior factors are caller loadings. */
export function fitGaussianComponent(input: GaussianFitInput): PredictionResult<GaussianFit> {
  const failure = fitFailure(input);
  if (failure !== undefined) return failure;

  try {
    return {status: 'ready', value: fitComponent(input)};
  } catch (error) {
    if (error instanceof PredictionNumericalError) return error.failure;
    throw error;
  }
}

function queryFailure(fit: GaussianFit, input: GaussianQueryInput): PredictionFailure | undefined {
  if (fit === null || typeof fit !== 'object' || input === null || typeof input !== 'object'
    || !validLimits(input.limits) || !isNonnegativeInteger(fit.latentDimension)
    || !isNonnegativeInteger(fit.observationCount) || !Number.isFinite(fit.logEvidence)
    || !Array.isArray(input.queryOffsets) || !Array.isArray(input.independentPriorFactors)) {
    return invalid('shape', 'Gaussian query requires a valid fit, arrays and explicit limits');
  }

  const dimension = fit.latentDimension;
  const count = input.queryOffsets.length;
  const independent = count === 0 ? 0 : input.independentPriorFactors[0]?.length;
  if (!isNonnegativeInteger(independent) || !isFiniteMatrix(fit.upper, dimension, dimension)
    || !isFiniteVector(fit.latentMean, dimension) || !isFiniteVector(input.queryOffsets, count)
    || !isFiniteMatrix(input.queryFactors, count, dimension)
    || !isFiniteMatrix(input.independentPriorFactors, count, independent)) {
    return invalid('shape', 'Gaussian query arrays must match the fitted and independent latent dimensions');
  }

  if (count > input.limits.maxQueries || dimension + independent > input.limits.maxLatentDimension
    || fit.observationCount > input.limits.maxObservations || input.limits.maxComponents < 1
    || !Number.isSafeInteger(count * (dimension + independent + count))) {
    return unsupported('capacity', 'Gaussian query exceeds the declared engineering limits');
  }

  for (let row = 0; row < dimension; row++) {
    if (fit.upper[row]![row] === 0) return invalid('fit_factor', 'Fitted upper factor has a zero pivot');
    for (let column = 0; column < row; column++) {
      if (fit.upper[row]![column] !== 0) return invalid('fit_factor', 'Fitted factor must be upper triangular');
    }
  }

  return undefined;
}

function project(fit: GaussianFit, input: GaussianQueryInput): GaussianPrediction {
  const mean = input.queryFactors.map((row, index) => numeric(
    input.queryOffsets[index]! + dot(row, fit.latentMean), 'query mean'));
  const covarianceFactor = input.queryFactors.map((row, index) => [
    ...rightSolve(row, fit.upper), ...input.independentPriorFactors[index]!,
  ]);
  return {mean, covarianceFactor, covariance: gram(covarianceFactor)};
}

/** Independent prior columns must be shared across queries according to their identity. */
export function predictGaussianComponent(fit: GaussianFit, input: GaussianQueryInput): PredictionResult<GaussianPrediction> {
  const failure = queryFailure(fit, input);
  if (failure !== undefined) return failure;

  try {
    return {status: 'ready', value: project(fit, input)};
  } catch (error) {
    if (error instanceof PredictionNumericalError) return error.failure;
    throw error;
  }
}
