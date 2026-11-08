export type PredictionFailure = {
  readonly status: 'invalid' | 'unsupported';
  readonly reason: string;
  readonly detail: string;
};

export type PredictionResult<T> = {readonly status: 'ready'; readonly value: T} | PredictionFailure;

export type NumericVector = readonly number[];

export type NumericMatrix = readonly NumericVector[];

export interface GaussianLimits {
  readonly maxObservations: number;
  readonly maxLatentDimension: number;
  readonly maxQueries: number;
  readonly maxComponents: number;
}

export interface GaussianFitInput {
  readonly latentDimension: number;
  readonly observations: NumericVector;
  readonly observationOffsets: NumericVector;
  readonly observationFactors: NumericMatrix;
  readonly noise: NumericMatrix;
  readonly limits: GaussianLimits;
}

export interface GaussianFit {
  readonly latentDimension: number;
  readonly observationCount: number;
  readonly upper: NumericMatrix;
  readonly latentMean: NumericVector;
  readonly logEvidence: number;
}

export interface GaussianQueryInput {
  readonly queryOffsets: NumericVector;
  readonly queryFactors: NumericMatrix;
  readonly independentPriorFactors: NumericMatrix;
  readonly limits: GaussianLimits;
}

export interface GaussianPrediction {
  readonly mean: NumericVector;
  readonly covariance: NumericMatrix;
  readonly covarianceFactor: NumericMatrix;
}

export interface GaussianMixtureComponent {
  readonly id: string;
  /** An unnormalized log mass is accepted; the returned value is normalized. */
  readonly logWeight: number;
  readonly mean: NumericVector;
  readonly covarianceFactor: NumericMatrix;
}

export interface NormalizedLogWeights {
  readonly logWeights: NumericVector;
  readonly logNormalizer: number;
}

export interface GaussianMixturePrediction extends GaussianPrediction {
  readonly components: readonly GaussianMixtureComponent[];
  readonly logNormalizer: number;
}
