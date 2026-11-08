import type { GaussianMixtureComponent, PredictionFailure, PredictionResult } from "./contracts.js";
import { fitGaussianComponent, predictGaussianComponent } from "./gaussian.js";
import { mixGaussianComponents, normalizeLogWeights } from "./mixture.js";
import type { FittedResponseComponent, SchedulingResponseFit, SchedulingResponseInput,
  SchedulingResponsePrediction, SchedulingResponseQuery } from "./response-contracts.js";
import { copyResponsePrior, responseDesign } from "./response-design.js";
import { validResponseFeatureMap, validResponsePrior,
  validReferenceList, validResponseTarget, validateResponseInput, validateResponseQueries } from "./response-validation.js";
import { invalid as invalidResponse, validLimits } from "./validation.js";

function componentFailure(failure: PredictionFailure, id: string): PredictionFailure {
  return { ...failure, detail: `${id}: ${failure.detail}` };
}

/** Rebuild from an externally resolved active projection; no observations are appended here. */
export function fitSchedulingResponse(input: SchedulingResponseInput): PredictionResult<SchedulingResponseFit> {
  const failure = validateResponseInput(input);
  if (failure !== undefined) return failure;

  const priors = normalizeLogWeights(input.hypotheses.map(item => item.logPriorWeight), input.limits.maxComponents);
  if (priors.status !== "ready") return priors;

  const groups = [...new Set(input.observations.map(item => item.group))].sort();
  const fitted: Omit<FittedResponseComponent, "logWeight">[] = [];

  for (const [index, hypothesis] of input.hypotheses.entries()) {
    const design = responseDesign(input.observations, hypothesis, groups, [], input.limits.maxLatentDimension);
    if (design.status !== "ready") return componentFailure(design, hypothesis.id);

    const posterior = fitGaussianComponent({ latentDimension: design.value.dimension,
      observations: input.observations.map(item => item.value), observationOffsets: design.value.offsets,
      observationFactors: design.value.factors, noise: hypothesis.noise, limits: input.limits });
    if (posterior.status !== "ready") return componentFailure(posterior, hypothesis.id);

    fitted.push({ prior: copyResponsePrior(hypothesis, priors.value.logWeights[index]!), posterior: posterior.value });
  }

  const weights = normalizeLogWeights(fitted.map(item => item.prior.logPriorWeight + item.posterior.logEvidence), input.limits.maxComponents);
  if (weights.status !== "ready") return weights;

  const facts = input.observations.map(item => Object.freeze({ id: item.id, sourceRef: item.sourceRef,
    revisionRef: item.revisionRef, instanceRef: item.instanceRef, baselineRef: item.baselineRef, group: item.group }));

  return { status: "ready", value: Object.freeze({ schemaVersion: 1,
    target: Object.freeze({ ...input.target }),
    featureMap: Object.freeze({ ...input.featureMap, sharedNames: Object.freeze([...input.featureMap.sharedNames]),
      localNames: Object.freeze([...input.featureMap.localNames]) }),
    limits: Object.freeze({ ...input.limits }), groups: Object.freeze(groups), facts: Object.freeze(facts),
    components: Object.freeze(fitted.map((item, index) => Object.freeze({ ...item, logWeight: weights.value.logWeights[index]! }))),
    logEvidence: weights.value.logNormalizer }) };
}

export const rebuildSchedulingResponse = fitSchedulingResponse;

function validateFit(fit: SchedulingResponseFit): PredictionFailure | undefined {
  if (fit === null || typeof fit !== "object" || fit.schemaVersion !== 1 || !validResponseTarget(fit.target)
    || !validResponseFeatureMap(fit.featureMap) || !validLimits(fit.limits)
    || !validReferenceList(fit.groups)
    || !Array.isArray(fit.facts) || !Array.isArray(fit.components) || fit.components.length === 0
    || !Number.isFinite(fit.logEvidence)) return invalidResponse("invalid_response_fit", "Expected a complete ephemeral response fit");

  if (fit.components.length > fit.limits.maxComponents) {
    return { status: "unsupported", reason: "capacity_exceeded", detail: "Response components exceed declared capacity" };
  }

  const ids = new Set<string>();

  for (const item of fit.components) {
    if (item === null || typeof item !== "object" || !validResponsePrior(item.prior, fit.featureMap)
      || !Number.isFinite(item.logWeight) || item.posterior === null || typeof item.posterior !== "object"
      || ids.has(item.prior.id)) return invalidResponse("invalid_response_fit", "Invalid or duplicate fitted component");
    ids.add(item.prior.id);
  }

  return undefined;
}

/** Predict latent conditional response. Future execution/measurement noise is not added implicitly. */
export function predictSchedulingResponse(fit: SchedulingResponseFit,
  input: { readonly queries: readonly SchedulingResponseQuery[] }): PredictionResult<SchedulingResponsePrediction> {
  const failure = validateFit(fit);
  if (failure !== undefined) return failure;

  if (input === null || typeof input !== "object") return invalidResponse("invalid_queries", "Expected response queries");

  const queryFailure = validateResponseQueries(input.queries, fit.target, fit.featureMap);
  if (queryFailure !== undefined) return queryFailure;

  if (input.queries.length > fit.limits.maxQueries) {
    return { status: "unsupported", reason: "capacity_exceeded", detail: "Response queries exceed declared capacity" };
  }

  const known = new Set(fit.groups);
  const newGroups = [...new Set(input.queries.map(item => item.group).filter(group => !known.has(group)))].sort();
  const components: GaussianMixtureComponent[] = [];

  for (const item of fit.components) {
    const design = responseDesign(input.queries, item.prior, fit.groups, newGroups, fit.limits.maxLatentDimension);
    if (design.status !== "ready") return componentFailure(design, item.prior.id);

    if (design.value.dimension !== item.posterior.latentDimension) {
      return invalidResponse("fit_basis_mismatch", "Response groups and posterior latent basis differ");
    }

    const prediction = predictGaussianComponent(item.posterior, { queryOffsets: design.value.offsets,
      queryFactors: design.value.factors, independentPriorFactors: design.value.independentFactors, limits: fit.limits });
    if (prediction.status !== "ready") return componentFailure(prediction, item.prior.id);

    components.push({ id: item.prior.id, logWeight: item.logWeight, mean: prediction.value.mean,
      covarianceFactor: prediction.value.covarianceFactor });
  }

  const mixed = mixGaussianComponents(components, fit.limits);
  if (mixed.status !== "ready") return mixed;

  const queries = input.queries.map(item => Object.freeze({ id: item.id, instanceRef: item.instanceRef,
    baselineRef: item.baselineRef, group: item.group,
    support: fit.facts.length === 0 ? "prior-only" as const : known.has(item.group) ? "local-observations" as const : "declared-transfer" as const }));

  return { status: "ready", value: Object.freeze({ schemaVersion: 1, target: fit.target, featureMapKey: fit.featureMap.key,
    interpretation: "latent-conditional-response", queries: Object.freeze(queries), mean: mixed.value.mean,
    covariance: mixed.value.covariance, covarianceFactor: mixed.value.covarianceFactor, components: mixed.value.components }) };
}
