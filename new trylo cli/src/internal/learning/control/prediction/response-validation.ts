import type { NumericMatrix, PredictionFailure } from "./contracts.js";
import { identity as hasReference } from "../../../validation/json-shape.js";
import type { ResponseCoordinates, ResponseFeatureMap, ResponsePrior, ResponseTarget,
  SchedulingResponseInput, SchedulingResponseQuery } from "./response-contracts.js";
import { invalid as invalidResponse, isFiniteMatrix, isFiniteVector, validLimits } from "./validation.js";

export function validReferenceList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (!hasReference(item)) return false;
  return new Set(value).size === value.length;
}

export function validResponseTarget(value: ResponseTarget): boolean {
  return value !== null && typeof value === "object" && hasReference(value.key) && hasReference(value.unit)
    && (value.stage === "initial" || value.stage === "continuation") && hasReference(value.referenceKey)
    && hasReference(value.baselineRuleKey) && hasReference(value.consumerKey);
}

export function validResponseFeatureMap(value: ResponseFeatureMap): boolean {
  return value !== null && typeof value === "object" && hasReference(value.key) && hasReference(value.sourceRef)
    && validReferenceList(value.sharedNames) && validReferenceList(value.localNames);
}

export function factorRank(value: NumericMatrix, rows: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns = rows === 0 ? 0 : Array.isArray(value[0]) ? value[0].length : -1;
  return columns >= 0 && isFiniteMatrix(value, rows, columns) ? columns : undefined;
}

export function validResponsePrior(prior: ResponsePrior, mapping: ResponseFeatureMap): boolean {
  return prior !== null && typeof prior === "object" && hasReference(prior.id) && hasReference(prior.sourceRef)
    && hasReference(prior.noiseSourceRef) && Number.isFinite(prior.logPriorWeight)
    && isFiniteVector(prior.sharedMean, mapping.sharedNames.length)
    && factorRank(prior.sharedFactor, mapping.sharedNames.length) !== undefined
    && factorRank(prior.localFactor, mapping.localNames.length) !== undefined;
}

function coordinatesValid(value: ResponseCoordinates, mapping: ResponseFeatureMap): boolean {
  return value !== null && typeof value === "object" && hasReference(value.instanceRef)
    && hasReference(value.baselineRef) && hasReference(value.group)
    && isFiniteVector(value.sharedFeatures, mapping.sharedNames.length)
    && isFiniteVector(value.localFeatures, mapping.localNames.length);
}

function coordinatesFailure(value: ResponseCoordinates, target: ResponseTarget,
  mapping: ResponseFeatureMap): PredictionFailure | undefined {
  if (!coordinatesValid(value, mapping)) return invalidResponse("invalid_response_coordinates", "Missing references or invalid feature coordinates");
  if (value.targetKey !== target.key) return invalidResponse("target_mismatch", "Response target family differs");
  if (value.featureMapKey !== mapping.key) return invalidResponse("feature_map_mismatch", "Response feature mapping differs");
  return undefined;
}

export function validateResponseInput(input: SchedulingResponseInput): PredictionFailure | undefined {
  if (input === null || typeof input !== "object" || !validLimits(input.limits)
    || !validResponseTarget(input.target) || !validResponseFeatureMap(input.featureMap)
    || !Array.isArray(input.observations) || !Array.isArray(input.hypotheses)) {
    return invalidResponse("invalid_response_input", "Expected explicit target, feature map, limits and arrays");
  }

  if (input.observations.length > input.limits.maxObservations || input.hypotheses.length > input.limits.maxComponents) {
    return { status: "unsupported", reason: "capacity_exceeded", detail: "Response fit exceeds declared capacity" };
  }

  if (input.hypotheses.length === 0) return invalidResponse("missing_hypotheses", "At least one proper hypothesis is required");

  const ids = new Set<string>();

  for (const fact of input.observations) {
    const failure = coordinatesFailure(fact, input.target, input.featureMap);
    if (failure !== undefined) return failure;

    if (!hasReference(fact.id) || !hasReference(fact.sourceRef) || !hasReference(fact.revisionRef) || !Number.isFinite(fact.value)) {
      return invalidResponse("invalid_response_fact", "Only qualified finite numeric facts may enter fit");
    }

    if (ids.has(fact.id)) return invalidResponse("duplicate_fact", `Duplicate active fact: ${fact.id}`);

    ids.add(fact.id);
  }

  const hypotheses = new Set<string>();

  for (const prior of input.hypotheses) {
    if (!validResponsePrior(prior, input.featureMap)
      || !isFiniteMatrix(prior.noise, input.observations.length, input.observations.length)) {
      return invalidResponse("invalid_response_hypothesis", "Prior factors and ordered full likelihood covariance must match");
    }
    if (hypotheses.has(prior.id)) return invalidResponse("duplicate_hypothesis", `Duplicate hypothesis: ${prior.id}`);
    hypotheses.add(prior.id);
  }

  return undefined;
}

export function validateResponseQueries(queries: readonly SchedulingResponseQuery[], target: ResponseTarget,
  mapping: ResponseFeatureMap): PredictionFailure | undefined {
  if (!Array.isArray(queries)) return invalidResponse("invalid_queries", "Expected an ordered query array");

  const ids = new Set<string>();

  for (const query of queries) {
    const failure = coordinatesFailure(query, target, mapping);
    if (failure !== undefined) return failure;
    if (!hasReference(query.id)) return invalidResponse("invalid_query", "Query identity is required");
    if (ids.has(query.id)) return invalidResponse("duplicate_query", `Duplicate query: ${query.id}`);
    ids.add(query.id);
  }

  return undefined;
}
