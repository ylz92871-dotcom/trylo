import type { GaussianFit, GaussianLimits, GaussianMixtureComponent, GaussianPrediction, NumericMatrix,
  NumericVector } from "./contracts.js";

/** A family fixes the estimand; individual baselines remain conditions within that family. */
export interface ResponseTarget {
  readonly key: string;
  readonly unit: string;
  readonly stage: "initial" | "continuation";
  readonly referenceKey: string;
  readonly baselineRuleKey: string;
  readonly consumerKey: string;
}

export interface ResponseFeatureMap {
  readonly key: string;
  readonly sourceRef: string;
  readonly sharedNames: readonly string[];
  readonly localNames: readonly string[];
}

export interface ResponseCoordinates {
  readonly targetKey: string;
  readonly featureMapKey: string;
  readonly instanceRef: string;
  readonly baselineRef: string;
  readonly group: string;
  readonly sharedFeatures: NumericVector;
  readonly localFeatures: NumericVector;
}

/** The original owner has already selected one effective numeric revision per fact. */
export interface ResponseObservation extends ResponseCoordinates {
  readonly id: string;
  readonly revisionRef: string;
  readonly sourceRef: string;
  readonly value: number;
}

export interface ResponsePrior {
  readonly id: string;
  readonly logPriorWeight: number;
  readonly sourceRef: string;
  readonly noiseSourceRef: string;
  readonly sharedMean: NumericVector;
  readonly sharedFactor: NumericMatrix;
  readonly localFactor: NumericMatrix;
}

export interface ResponseHypothesis extends ResponsePrior {
  /** Total qualified likelihood covariance, in the exact observation order. */
  readonly noise: NumericMatrix;
}

export interface SchedulingResponseInput {
  readonly target: ResponseTarget;
  readonly featureMap: ResponseFeatureMap;
  readonly observations: readonly ResponseObservation[];
  readonly hypotheses: readonly ResponseHypothesis[];
  readonly limits: GaussianLimits;
}

export interface ResponseFactReference {
  readonly id: string;
  readonly revisionRef: string;
  readonly sourceRef: string;
  readonly instanceRef: string;
  readonly baselineRef: string;
  readonly group: string;
}

export interface FittedResponseComponent {
  readonly prior: ResponsePrior;
  readonly posterior: GaussianFit;
  readonly logWeight: number;
}

/** Ephemeral pure fit state. This is neither a retained fact ledger nor a persistence format. */
export interface SchedulingResponseFit {
  readonly schemaVersion: 1;
  readonly target: ResponseTarget;
  readonly featureMap: ResponseFeatureMap;
  readonly limits: GaussianLimits;
  readonly groups: readonly string[];
  readonly facts: readonly ResponseFactReference[];
  readonly components: readonly FittedResponseComponent[];
  readonly logEvidence: number;
}

export interface SchedulingResponseQuery extends ResponseCoordinates {
  readonly id: string;
}

export interface ResponseQueryReference {
  readonly id: string;
  readonly instanceRef: string;
  readonly baselineRef: string;
  readonly group: string;
  readonly support: "prior-only" | "local-observations" | "declared-transfer";
}

export interface SchedulingResponsePrediction extends GaussianPrediction {
  readonly schemaVersion: 1;
  readonly target: ResponseTarget;
  readonly featureMapKey: string;
  readonly interpretation: "latent-conditional-response";
  readonly queries: readonly ResponseQueryReference[];
  readonly components: readonly GaussianMixtureComponent[];
}
