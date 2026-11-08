/** Pure central forecasts. No runtime, persistence, permission or allocation side effects. */
export const CENTRAL_PREDICTION_API_VERSION = 1 as const;

export { fitSchedulingResponse, rebuildSchedulingResponse, predictSchedulingResponse } from "./response.js";
export { fitNonnegativeCost, predictNonnegativeCost } from "./cost.js";
export { predictBetaBinomialDemand } from "./demand.js";
export { boundExpectedNeedGain } from "./dependence.js";
export type { PredictionFailure, PredictionResult, GaussianLimits, NumericMatrix, NumericVector } from "./contracts.js";
export type { ResponseTarget, ResponseFeatureMap, ResponseCoordinates, ResponseObservation, ResponseHypothesis,
  ResponsePrior, SchedulingResponseInput, SchedulingResponseFit, SchedulingResponseQuery,
  SchedulingResponsePrediction } from "./response-contracts.js";
export type { CostReceipt, CostReceiptReference, NonnegativeCostHypothesis, NonnegativeCostInput, NonnegativeCostFit,
  NonnegativeCostQuery, NonnegativeCostPrediction, ScalarCostMoments } from "./cost-contracts.js";
export type { BetaBinomialDemandInput, BetaBinomialDemandPrediction } from "./demand.js";
export type { ExpectedNeedGainInput, ExpectedNeedGainBounds } from "./dependence.js";
