import type {
  GaussianLimits, GaussianMixtureComponent, GaussianMixturePrediction, NormalizedLogWeights,
  NumericVector, PredictionFailure, PredictionResult,
} from './contracts.js';
import {gram, numeric, PredictionNumericalError, stableSum, unresolved} from './linear-algebra.js';
import {invalid, isFiniteMatrix, isFiniteVector, isNonnegativeInteger, unsupported, validLimits} from './validation.js';

function normalized(logMasses: NumericVector): NormalizedLogWeights {
  let maximum = -Infinity;

  for (const value of logMasses) maximum = Math.max(maximum, value);

  const shifted = logMasses.map(value => numeric(value - maximum, 'log weight shift'));
  const logScaledSum = Math.log(stableSum(shifted.map(value => Math.exp(value)), 'log normalizer'));

  return {
    // Subtract the common scale first: max+logScaledSum may round back to max.
    logWeights: shifted.map(value => numeric(value - logScaledSum, 'normalized log weight')),
    logNormalizer: numeric(maximum + logScaledSum, 'log normalizer'),
  };
}

export function normalizeLogWeights(logMasses: NumericVector, maxComponents: number): PredictionResult<NormalizedLogWeights> {
  if (!isNonnegativeInteger(maxComponents) || !Array.isArray(logMasses) || logMasses.length === 0
    || !isFiniteVector(logMasses, logMasses.length)) {
    return invalid('log_weights', 'Log masses must be nonempty and finite with an explicit component capacity');
  }

  if (logMasses.length > maxComponents) return unsupported('capacity', 'Too many finite hypotheses');

  try {
    return {status: 'ready', value: normalized(logMasses)};
  } catch (error) {
    if (error instanceof PredictionNumericalError) return error.failure;
    throw error;
  }
}

interface WeightedValue {readonly logWeight: number; readonly value: number}

function exactOpposites(terms: readonly WeightedValue[]): boolean {
  const paired = terms.map(() => false);

  for (let index = 0; index < terms.length; index++) {
    if (paired[index]) continue;

    const term = terms[index]!;
    const opposite = terms.findIndex((other, candidate) => candidate > index && !paired[candidate]
      && other.logWeight === term.logWeight && other.value === -term.value);
    if (opposite < 0) return false;

    paired[index] = true;
    paired[opposite] = true;
  }

  return true;
}

/** Never form exp(logWeight) before multiplying a potentially large response. */
function weightedMean(values: readonly WeightedValue[]): number {
  const terms = values.filter(term => term.value !== 0);
  if (terms.length === 0) return 0;

  const logs = terms.map(term => numeric(term.logWeight + Math.log(Math.abs(term.value)), 'weighted mean log'));
  let maximum = -Infinity;

  for (const value of logs) maximum = Math.max(maximum, value);

  const scaled = logs.map((value, index) => {
    const magnitude = Math.exp(numeric(value - maximum, 'weighted mean scaling'));
    if (magnitude === 0) unresolved('weighted mean: scaled contribution underflow');
    return Math.sign(terms[index]!.value) * magnitude;
  });
  const total = stableSum(scaled, 'signed weighted mean');
  if (total === 0) {
    if (exactOpposites(terms)) return 0;
    unresolved('weighted mean: signed cancellation unresolved');
  }

  const magnitude = numeric(Math.exp(numeric(maximum + Math.log(Math.abs(total)), 'weighted mean exponent')), 'weighted mean');
  if (magnitude === 0) unresolved('weighted mean: result underflow');

  return Math.sign(total) * magnitude;
}

function scaledFactor(value: number, logWeight: number): number {
  if (value === 0) return 0;
  const exponent = numeric(0.5 * logWeight + Math.log(Math.abs(value)), 'mixture factor exponent');
  const magnitude = numeric(Math.exp(exponent), 'mixture factor');
  if (magnitude === 0) unresolved('mixture factor: contribution underflow');
  return Math.sign(value) * magnitude;
}

function mixtureFailure(components: readonly GaussianMixtureComponent[], limits: GaussianLimits): PredictionFailure | undefined {
  if (!validLimits(limits) || !Array.isArray(components) || components.length === 0) {
    return invalid('shape', 'Gaussian mixture requires components and explicit limits');
  }

  if (components.length > limits.maxComponents) return unsupported('capacity', 'Too many mixture components');

  const ids = new Set<string>();
  let queries: number | undefined;
  let factorColumns = components.length;

  for (const component of components) {
    if (component === null || typeof component !== 'object' || typeof component.id !== 'string'
      || component.id.trim().length === 0 || ids.has(component.id) || !Number.isFinite(component.logWeight)
      || !Array.isArray(component.mean) || !Array.isArray(component.covarianceFactor)) {
      return invalid('component', 'Components require unique IDs, finite log masses and arrays');
    }

    ids.add(component.id);
    const queryCount: unknown = component.mean.length;
    if (!isNonnegativeInteger(queryCount) || (queries !== undefined && queries !== queryCount)) {
      return invalid('shape', 'All components must describe the same finite query count');
    }

    queries = queryCount;
    const width = queryCount === 0 ? 0 : component.covarianceFactor[0]?.length;
    if (!isNonnegativeInteger(width) || !isFiniteVector(component.mean, queryCount)
      || !isFiniteMatrix(component.covarianceFactor, queryCount, width)) {
      return invalid('shape', 'All component query identities and factor shapes must match');
    }

    factorColumns += width;

    if (queryCount > limits.maxQueries || width > limits.maxLatentDimension
      || !Number.isSafeInteger(queryCount * (factorColumns + queryCount))) {
      return unsupported('capacity', 'Mixture query factors exceed the declared engineering limits');
    }
  }

  return undefined;
}

function combine(components: readonly GaussianMixtureComponent[], weights: NormalizedLogWeights): GaussianMixturePrediction {
  const normalizedComponents = components.map((component, index) => ({
    id: component.id, logWeight: weights.logWeights[index]!, mean: [...component.mean],
    covarianceFactor: component.covarianceFactor.map(row => [...row]),
  }));
  const count = normalizedComponents[0]!.mean.length;
  const mean = Array.from({length: count}, (_, query) => weightedMean(normalizedComponents.map(component => ({
    logWeight: component.logWeight, value: component.mean[query]!,
  }))));
  const covarianceFactor = Array.from({length: count}, () => [] as number[]);

  for (const component of normalizedComponents) {
    for (let query = 0; query < count; query++) {
      for (const value of component.covarianceFactor[query]!) {
        covarianceFactor[query]!.push(scaledFactor(value, component.logWeight));
      }
      const centered = numeric(component.mean[query]! - mean[query]!, 'mixture center');
      covarianceFactor[query]!.push(scaledFactor(centered, component.logWeight));
    }
  }

  return {
    mean, covarianceFactor, covariance: gram(covarianceFactor),
    components: normalizedComponents, logNormalizer: weights.logNormalizer,
  };
}

/** Preserve the mixture; a covariance factor represents only its second moments. */
export function mixGaussianComponents(
  components: readonly GaussianMixtureComponent[], limits: GaussianLimits,
): PredictionResult<GaussianMixturePrediction> {
  const failure = mixtureFailure(components, limits);
  if (failure !== undefined) return failure;

  const weights = normalizeLogWeights(components.map(component => component.logWeight), limits.maxComponents);
  if (weights.status !== 'ready') return weights;

  try {
    return {status: 'ready', value: combine(components, weights.value)};
  } catch (error) {
    if (error instanceof PredictionNumericalError) return error.failure;
    throw error;
  }
}
