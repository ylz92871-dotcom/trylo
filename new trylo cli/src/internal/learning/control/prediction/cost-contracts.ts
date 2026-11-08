import type { BetaGroupPosterior, BetaGroupPrior } from "./beta.js";
import type { GaussianFit, GaussianLimits, NumericMatrix, NumericVector } from "./contracts.js";

export type CostReceipt = {
  readonly id: string; readonly gateGroupId: string; readonly sourceRef: string; readonly revisionRef: string;
} & ({ readonly status: "complete"; readonly amount: number } | { readonly status: "unknown" });

export type CostReceiptReference = {
  readonly id: string; readonly gateGroupId: string; readonly sourceRef: string; readonly revisionRef: string;
  readonly status: "complete" | "unknown";
};

export type NonnegativeCostHypothesis = {
  readonly id: string; readonly sourceRef: string; readonly priorLogWeight: number;
  readonly gatePriors: readonly BetaGroupPrior[];
  readonly positiveLog: {
    readonly latentDimension: number; readonly rowIds: readonly string[];
    readonly observationOffsets: NumericVector; readonly observationFactors: NumericMatrix; readonly noise: NumericMatrix;
  };
};

/** Exact for the declared continuous positive-resource log-Gaussian receipt law.
 * Integer token rounding requires a different likelihood; unknown receipts never become zeros.
 */
export type NonnegativeCostInput = {
  readonly targetKey: string; readonly resourceUnit: string; readonly referenceAmount: number;
  readonly conditionalIndependence: "gate-and-positive-log-given-h";
  readonly receipts: readonly CostReceipt[]; readonly hypotheses: readonly NonnegativeCostHypothesis[];
  readonly limits: GaussianLimits;
};

export type FittedCostComponent = {
  readonly id: string; readonly sourceRef: string; readonly logWeight: number;
  readonly gatePosteriors: readonly BetaGroupPosterior[]; readonly gateLogEvidence: number;
  readonly positiveRowIds: readonly string[]; readonly positiveLogFit: GaussianFit;
};

export type NonnegativeCostFit = {
  readonly targetKey: string; readonly resourceUnit: string; readonly referenceAmount: number;
  readonly conditionalIndependence: "gate-and-positive-log-given-h";
  readonly limits: GaussianLimits; readonly components: readonly FittedCostComponent[];
  readonly receiptRefs: readonly CostReceiptReference[];
  readonly support: { readonly knownZeroCount: number; readonly knownPositiveCount: number; readonly unknownCount: number };
};

export type NonnegativeCostQuery = {
  readonly targetKey: string; readonly gateGroupId: string;
  readonly components: readonly {
    readonly hypothesisId: string; readonly queryOffset: number; readonly queryFactor: NumericVector;
    readonly independentPriorFactor: NumericVector; readonly logResidualVariance: number;
  }[];
};

export type ScalarCostMoments = {
  readonly positiveProbability: number; readonly zeroProbability: number; readonly mean: number;
  readonly actualVariance: number; readonly latentMeanVariance: number; readonly expectedProcessVariance: number;
};

export type NonnegativeCostPrediction = ScalarCostMoments & {
  readonly targetKey: string; readonly resourceUnit: string; readonly referenceAmount: number;
  readonly gateGroupId: string; readonly joint: "single-query-marginal-only";
  readonly components: readonly (ScalarCostMoments & { readonly id: string; readonly sourceRef: string; readonly logWeight: number })[];
};
