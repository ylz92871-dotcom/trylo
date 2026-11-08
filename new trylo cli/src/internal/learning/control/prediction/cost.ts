import { identity } from "../../../validation/json-shape.js";
import { betaMoments, rebuildBetaGroups } from "./beta.js";
import type { BetaMoments } from "./beta.js";
import type { GaussianLimits, PredictionFailure, PredictionResult } from "./contracts.js";
import { fitGaussianComponent, predictGaussianComponent } from "./gaussian.js";
import { normalizeLogWeights } from "./mixture.js";
import { invalid, unsupported, validLimits } from "./validation.js";
import type {
  FittedCostComponent, NonnegativeCostFit, NonnegativeCostHypothesis, NonnegativeCostInput,
  NonnegativeCostPrediction, NonnegativeCostQuery, ScalarCostMoments,
} from "./cost-contracts.js";

function numericRange(detail: string): PredictionFailure {
  return unsupported("numeric_range", detail);
}

type PreparedReceipts = {
  readonly positiveIds: readonly string[]; readonly positiveLogs: readonly number[];
  readonly gateFacts: readonly { readonly groupId: string; readonly outcome: 0 | 1 }[];
  readonly receiptRefs: NonnegativeCostFit["receiptRefs"];
  readonly support: NonnegativeCostFit["support"];
};

function prepareReceipts(input: NonnegativeCostInput): PredictionResult<PreparedReceipts> {
  const ids = new Set<string>(), positiveIds: string[] = [], positiveLogs: number[] = [];
  const gateFacts: { groupId: string; outcome: 0 | 1 }[] = [];
  const receiptRefs: NonnegativeCostFit["receiptRefs"][number][] = [];
  let knownZeroCount = 0, unknownCount = 0;

  for (const receipt of input.receipts) {
    if (!receipt || !identity(receipt.id) || ids.has(receipt.id) || !identity(receipt.gateGroupId)
      || !identity(receipt.sourceRef) || !identity(receipt.revisionRef)) {
      return invalid("prediction_cost_receipt", "Cost facts require unique identities and explicit source/revision references.");
    }

    ids.add(receipt.id);

    if (receipt.status !== "unknown" && receipt.status !== "complete") {
      return invalid("prediction_cost_receipt", "Cost facts require a complete or unknown receipt state.");
    }

    receiptRefs.push({ id: receipt.id, gateGroupId: receipt.gateGroupId, sourceRef: receipt.sourceRef,
      revisionRef: receipt.revisionRef, status: receipt.status });

    if (receipt.status === "unknown") {
      unknownCount += 1;
      continue;
    }

    if (receipt.status !== "complete" || !Number.isFinite(receipt.amount) || receipt.amount < 0) {
      return invalid("prediction_cost_receipt", "Complete actual cost must be finite and nonnegative.");
    }

    if (receipt.amount === 0) {
      knownZeroCount += 1;
      gateFacts.push({ groupId: receipt.gateGroupId, outcome: 0 });
    }
    else {
      positiveIds.push(receipt.id);
      // Equivalent to log(amount/c0), without overflowing the intermediate ratio.
      positiveLogs.push(Math.log(receipt.amount) - Math.log(input.referenceAmount));
      gateFacts.push({ groupId: receipt.gateGroupId, outcome: 1 });
    }
  }

  return { status: "ready", value: { positiveIds, positiveLogs, gateFacts, receiptRefs,
    support: { knownZeroCount, knownPositiveCount: positiveIds.length, unknownCount } } };
}

function fitCostComponent(hypothesis: NonnegativeCostHypothesis, prepared: PreparedReceipts,
  limits: GaussianLimits): PredictionResult<Omit<FittedCostComponent, "logWeight"> & { readonly logMass: number }> {
  if (!hypothesis || !identity(hypothesis.id) || !identity(hypothesis.sourceRef) || !Number.isFinite(hypothesis.priorLogWeight)
    || !Array.isArray(hypothesis.gatePriors) || hypothesis.gatePriors.length > limits.maxObservations + limits.maxQueries
    || !hypothesis.positiveLog || !Array.isArray(hypothesis.positiveLog.rowIds)
    || hypothesis.positiveLog.rowIds.length !== prepared.positiveIds.length
    || !prepared.positiveIds.every((id, index) => hypothesis.positiveLog.rowIds[index] === id)) {
    return invalid("prediction_cost_hypothesis", "Each declared hypothesis must bind the exact ordered positive fact rows and gate priors.");
  }

  const gate = rebuildBetaGroups(hypothesis.gatePriors, prepared.gateFacts);
  if (gate.status !== "ready") return gate;

  const positive = fitGaussianComponent({ latentDimension: hypothesis.positiveLog.latentDimension,
    observations: prepared.positiveLogs, observationOffsets: hypothesis.positiveLog.observationOffsets,
    observationFactors: hypothesis.positiveLog.observationFactors, noise: hypothesis.positiveLog.noise, limits });
  if (positive.status !== "ready") return positive;

  const logMass = hypothesis.priorLogWeight + gate.value.logEvidence + positive.value.logEvidence;
  if (!Number.isFinite(logMass)) return numericRange("Joint gate and positive-cost evidence exceeds the numeric range.");

  return { status: "ready", value: { id: hypothesis.id, sourceRef: hypothesis.sourceRef, logMass,
    gatePosteriors: gate.value.groups, gateLogEvidence: gate.value.logEvidence,
    positiveRowIds: [...prepared.positiveIds], positiveLogFit: positive.value } };
}

/** Rebuild from the caller's active complete/unknown projection; never writes or resolves revisions. */
export function fitNonnegativeCost(input: NonnegativeCostInput): PredictionResult<NonnegativeCostFit> {
  if (!input || !identity(input.targetKey) || !identity(input.resourceUnit) || !Number.isFinite(input.referenceAmount)
    || input.referenceAmount <= 0 || input.conditionalIndependence !== "gate-and-positive-log-given-h"
    || !validLimits(input.limits) || !Array.isArray(input.receipts) || input.receipts.length > input.limits.maxObservations
    || !Array.isArray(input.hypotheses) || input.hypotheses.length === 0 || input.hypotheses.length > input.limits.maxComponents) {
    return invalid("prediction_cost_input", "Cost fitting requires explicit target, units, independence, hypotheses and bounded facts.");
  }

  const prepared = prepareReceipts(input);
  if (prepared.status !== "ready") return prepared;

  const fitted: (Omit<FittedCostComponent, "logWeight"> & { readonly logMass: number })[] = [], ids = new Set<string>();

  for (const hypothesis of input.hypotheses) {
    const component = fitCostComponent(hypothesis, prepared.value, input.limits);
    if (component.status !== "ready") return component;
    if (ids.has(component.value.id)) return invalid("prediction_cost_hypothesis", "Cost hypothesis identities must be unique.");
    ids.add(component.value.id);
    fitted.push(component.value);
  }

  const weights = normalizeLogWeights(fitted.map(component => component.logMass), input.limits.maxComponents);
  if (weights.status !== "ready") return weights;

  const components = fitted.map((component, index) => ({ id: component.id, sourceRef: component.sourceRef,
    gatePosteriors: component.gatePosteriors, gateLogEvidence: component.gateLogEvidence,
    positiveRowIds: component.positiveRowIds, positiveLogFit: component.positiveLogFit, logWeight: weights.value.logWeights[index]! }));

  return { status: "ready", value: { targetKey: input.targetKey, resourceUnit: input.resourceUnit, referenceAmount: input.referenceAmount,
    conditionalIndependence: input.conditionalIndependence, limits: { ...input.limits }, components,
    receiptRefs: prepared.value.receiptRefs, support: prepared.value.support } };
}

function logAdd(left: number, right: number): number {
  if (left === -Infinity) return right;
  if (right === -Infinity) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log1p(Math.exp(Math.min(left, right) - maximum));
}

function logExpm1(value: number): number {
  if (value === 0) return -Infinity;
  return value > Math.LN2 ? value + Math.log1p(-Math.exp(-value)) : Math.log(Math.expm1(value));
}

function exponentiate(logValue: number): PredictionResult<number> {
  if (logValue === -Infinity) return { status: "ready", value: 0 };
  const value = Math.exp(logValue);
  if (!Number.isFinite(logValue) || !Number.isFinite(value) || value === 0) {
    return numericRange("A positive cost moment cannot be represented in the numeric range.");
  }
  return { status: "ready", value };
}

function costMoments(gate: BetaMoments, referenceAmount: number, mean: number, variance: number,
  residualVariance: number): PredictionResult<ScalarCostMoments> {
  if (![mean, variance, residualVariance].every(Number.isFinite) || variance < 0 || residualVariance < 0) {
    return invalid("prediction_cost_query", "Log-mean and future real residual variances must be finite and nonnegative.");
  }

  if (gate.mean === 0 || gate.zeroProbability === 0) return numericRange("Gate probabilities underflow the numeric range.");

  const logMplus = Math.log(referenceAmount) + mean + (variance + residualVariance) / 2;
  const costMean = exponentiate(gate.logMean + logMplus);
  if (costMean.status !== "ready") return costMean;

  // All terms are nonnegative. No Q - mean² cancellation or posterior-variance clipping.
  const actual = exponentiate(2 * logMplus + logAdd(gate.logMean + gate.logZeroProbability,
    gate.logMean + logExpm1(variance + residualVariance)));
  if (actual.status !== "ready") return actual;

  const latent = exponentiate(2 * logMplus + logAdd(gate.logVariance, gate.logSecondMoment + logExpm1(variance)));
  if (latent.status !== "ready") return latent;

  const processVarianceResult = exponentiate(2 * logMplus + variance + logAdd(gate.logExpectedBernoulliVariance,
    gate.logMean + logExpm1(residualVariance)));
  if (processVarianceResult.status !== "ready") return processVarianceResult;

  return { status: "ready", value: { positiveProbability: gate.mean, zeroProbability: gate.zeroProbability,
    mean: costMean.value, actualVariance: actual.value, latentMeanVariance: latent.value, expectedProcessVariance: processVarianceResult.value } };
}

type CostPredictionComponent = NonnegativeCostPrediction["components"][number];

function validFittedComponent(component: FittedCostComponent): boolean {
  if (!component || !identity(component.id) || !identity(component.sourceRef) || !component.positiveLogFit
    || (!Number.isFinite(component.logWeight) && component.logWeight !== -Infinity) || !Array.isArray(component.gatePosteriors)) return false;

  const groups = new Set<string>();

  for (const group of component.gatePosteriors) {
    if (!group || !identity(group.groupId) || groups.has(group.groupId)
      || !Number.isFinite(group.alpha) || group.alpha <= 0 || !Number.isFinite(group.beta) || group.beta <= 0) return false;
    groups.add(group.groupId);
  }

  return true;
}

function predictCostComponent(fit: NonnegativeCostFit, component: FittedCostComponent,
  query: NonnegativeCostQuery["components"][number], groupId: string, logWeight: number): PredictionResult<CostPredictionComponent> {
  const group = component.gatePosteriors.find(candidate => candidate.groupId === groupId);
  if (!group) return { status: "unsupported", reason: "prediction_cost_gate_prior", detail: "The requested group has no declared gate prior in every hypothesis." };

  const gate = betaMoments(group.alpha, group.beta);
  if (gate.status !== "ready") return gate;

  const positive = predictGaussianComponent(component.positiveLogFit, { queryOffsets: [query.queryOffset],
    queryFactors: [query.queryFactor], independentPriorFactors: [query.independentPriorFactor], limits: fit.limits });
  if (positive.status !== "ready") return positive;

  const mean = positive.value.mean[0], variance = positive.value.covariance[0]?.[0];
  if (mean === undefined || variance === undefined) return invalid("prediction_cost_query", "Cost prediction requires one scalar log query.");

  const moments = costMoments(gate.value, fit.referenceAmount, mean, variance, query.logResidualVariance);
  if (moments.status !== "ready") return moments;

  return { status: "ready", value: { ...moments.value, id: component.id, sourceRef: component.sourceRef, logWeight } };
}

function weightedSum(components: readonly CostPredictionComponent[], select: (component: CostPredictionComponent) => number): PredictionResult<number> {
  let total = -Infinity;

  for (const component of components) {
    const value = select(component);
    if (!Number.isFinite(value) || value < 0) return numericRange("A cost mixture term exceeds the numeric range.");
    if (value > 0) total = logAdd(total, component.logWeight + Math.log(value));
  }

  return exponentiate(total);
}

function mixtureVariance(components: readonly CostPredictionComponent[], mean: number,
  select: (component: CostPredictionComponent) => number): PredictionResult<number> {
  let total = -Infinity;

  for (const component of components) {
    const within = select(component), difference = Math.abs(component.mean - mean);
    const logWithin = within === 0 ? -Infinity : Math.log(within);
    const logBetween = difference === 0 ? -Infinity : 2 * Math.log(difference);
    total = logAdd(total, component.logWeight + logAdd(logWithin, logBetween));
  }

  return exponentiate(total);
}

function mixCostMoments(components: readonly CostPredictionComponent[]): PredictionResult<ScalarCostMoments> {
  const mean = weightedSum(components, component => component.mean);
  if (mean.status !== "ready") return mean;

  const positive = weightedSum(components, component => component.positiveProbability);
  if (positive.status !== "ready") return positive;

  const zero = weightedSum(components, component => component.zeroProbability);
  if (zero.status !== "ready") return zero;

  const actual = mixtureVariance(components, mean.value, component => component.actualVariance);
  if (actual.status !== "ready") return actual;

  const latent = mixtureVariance(components, mean.value, component => component.latentMeanVariance);
  if (latent.status !== "ready") return latent;

  const processVarianceResult = weightedSum(components, component => component.expectedProcessVariance);
  if (processVarianceResult.status !== "ready") return processVarianceResult;

  return { status: "ready", value: { positiveProbability: positive.value, zeroProbability: zero.value, mean: mean.value,
    actualVariance: actual.value, latentMeanVariance: latent.value, expectedProcessVariance: processVarianceResult.value } };
}

/** Scalar marginal moments only. Latent-mean uncertainty may include unseen-group heterogeneity.
 * Neither these moments nor shared h identify actual cross-depth or value-cost coupling.
 */
export function predictNonnegativeCost(fit: NonnegativeCostFit, query: NonnegativeCostQuery): PredictionResult<NonnegativeCostPrediction> {
  if (!fit || !query || !identity(fit.targetKey) || !identity(fit.resourceUnit)
    || !identity(query.targetKey) || query.targetKey !== fit.targetKey || !identity(query.gateGroupId)
    || !validLimits(fit.limits) || !Number.isFinite(fit.referenceAmount) || fit.referenceAmount <= 0
    || fit.conditionalIndependence !== "gate-and-positive-log-given-h" || !Array.isArray(fit.components)
    || fit.components.length === 0 || fit.components.length > fit.limits.maxComponents || !Array.isArray(query.components)
    || query.components.length !== fit.components.length) {
    return invalid("prediction_cost_query", "Cost query target and complete hypothesis set must match the fitted model.");
  }

  for (const component of fit.components) {
    if (!validFittedComponent(component)) return invalid("prediction_cost_query", "A fitted cost component is malformed.");
  }

  const queries = new Map<string, NonnegativeCostQuery["components"][number]>();

  for (const component of query.components) {
    if (!component || !identity(component.hypothesisId) || queries.has(component.hypothesisId)
      || !Number.isFinite(component.queryOffset) || !Array.isArray(component.queryFactor) || !Array.isArray(component.independentPriorFactor)
      || !Number.isFinite(component.logResidualVariance) || component.logResidualVariance < 0) {
      return invalid("prediction_cost_query", "Each scalar query requires a unique hypothesis identity and explicit real residual variance.");
    }
    queries.set(component.hypothesisId, component);
  }

  if (new Set(fit.components.map(component => component.id)).size !== fit.components.length) return invalid("prediction_cost_query", "Fitted hypothesis identities are not unique.");

  const weights = normalizeLogWeights(fit.components.map(component => component.logWeight), fit.limits.maxComponents);
  if (weights.status !== "ready") return weights;

  const components: CostPredictionComponent[] = [];

  for (const [index, component] of fit.components.entries()) {
    const componentQuery = queries.get(component.id);
    if (!componentQuery || !Array.isArray(component.gatePosteriors)) return invalid("prediction_cost_query", "A fitted hypothesis or gate posterior is missing from the query.");
    const predicted = predictCostComponent(fit, component, componentQuery, query.gateGroupId, weights.value.logWeights[index]!);
    if (predicted.status !== "ready") return predicted;
    components.push(predicted.value);
  }

  const mixed = mixCostMoments(components);
  if (mixed.status !== "ready") return mixed;

  return { status: "ready", value: { ...mixed.value, targetKey: fit.targetKey, resourceUnit: fit.resourceUnit,
    referenceAmount: fit.referenceAmount, gateGroupId: query.gateGroupId, joint: "single-query-marginal-only", components } };
}
