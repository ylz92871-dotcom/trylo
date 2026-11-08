import { fields, list } from "../../../validation/json-shape.js";
import { isAllocationBasis } from "../allocation-shape.js";
import type { LearningAllocationBasis } from "../allocation-contract.js";
import { contentHashOf } from "../hash.js";
import { predictBetaBinomialDemand } from "../prediction/index.js";
import type { CentralPursuitCandidate, CentralPursuitObjective, CentralPursuitObservation,
  CentralPursuitPrediction } from "./pursuit-contract.js";
import { isCentralResponseOpportunity } from "./prediction-validation.js";
import { isCentralPursuitObjective, isCentralPursuitObservation } from "./pursuit-validation.js";
import { advanceCentralPursuitResourceModel, centralPursuitTreatmentRef, fitCentralPursuitResourceModel,
  predictCentralPursuitResourceModel } from "./pursuit-resource-model.js";

const REFERENCE_SOURCE = "research:central-decision-continuation-20261104/cold-start-research.md#8.1";
const MODEL = "jeffreys_bernoulli_reference_v1" as const;
const assumptions = Object.freeze([
  "Jeffreys Beta(1/2,1/2) is a reference prior for the declared Bernoulli objective, not observed success history",
  "One independent objective episode contributes one effective outcome; revisions are resolved by the source owner",
  "A family source declares compatible semantic, sampling, stopping, condition and resource protocols",
  "An explicit resource model averages shared-response and exact-treatment-response hypotheses using their marginal evidence",
  "The resource hypothesis prior is a symmetric reference choice, not empirical evidence that resources have no effect",
  "The point prediction conditions on revealed labels and assumes their observation mechanism is ignorable",
  "Pending labels remain incomplete; their completion range is not a confidence interval or an observed fact",
  "Objective completion is not economic gross gain, checker verification or adoption of a different criterion",
]);

export type CentralPursuitPredictionResult = {
  readonly status: "ready";
  readonly predictions: readonly CentralPursuitPrediction[];
  readonly modelRef: string;
  readonly assumptions: readonly string[];
} | { readonly status: "invalid" | "unsupported"; readonly reason: string };

/** The family source owns transfer compatibility. Policy ids and resource envelopes
 * are not silently equated merely because they share an objective label. */
export function centralPursuitFamilyKey(scope: string, objective: CentralPursuitObjective, conditionRef: string): string {
  return contentHashOf([scope, objective.criterion, objective.definitionRef, objective.familyRef,
    objective.familySourceRef, conditionRef, objective.resourceModel ?? null]);
}

function validCandidates(candidates: unknown, basis: LearningAllocationBasis): candidates is readonly CentralPursuitCandidate[] {
  if (!list(candidates, 0, 30)) return false;

  // Execution/readiness/fee sidecars belong to the composition boundary. This
  // forecast validates the canonical opportunity and objective it actually uses.
  const ids = new Set<string>();

  for (const candidate of candidates) {
    if (!(fields(candidate,
    ["opportunity", "source", "readiness", "target", "fee", "purpose", "objective"])
    && isCentralResponseOpportunity(candidate.opportunity) && isCentralPursuitObjective(candidate.objective)
    && candidate.opportunity.scope === basis.scope
    && (candidate.purpose === "focused_learning" || candidate.purpose === "required_preparation"))) return false;

    if (ids.has(candidate.opportunity.opportunityId)) return false;

    ids.add(candidate.opportunity.opportunityId);
  }

  return true;
}

function validObservations(observations: unknown, basis: LearningAllocationBasis): observations is readonly CentralPursuitObservation[] {
  if (!Array.isArray(observations) || !observations.every((row): row is CentralPursuitObservation => isCentralPursuitObservation(row)
    && row.scope === basis.scope && row.sequence <= basis.boardSequence)) return false;
  return new Set(observations.map(row => row.unitId)).size === observations.length
    && new Set(observations.map(row => contentHashOf([row.scope, row.objective.instanceId]))).size === observations.length;
}

/** Pure rebuild from the original owner's effective observations. Cold start has
 * a declared reference prediction without inventing measured outcomes or noise. */
export function predictCentralPursuitCandidates(candidates: readonly CentralPursuitCandidate[],
  observations: readonly CentralPursuitObservation[], basis: LearningAllocationBasis): CentralPursuitPredictionResult {
  if (!isAllocationBasis(basis) || !validCandidates(candidates, basis) || !validObservations(observations, basis)) {
    return { status: "invalid", reason: "central_pursuit_prediction_input" };
  }

  const histories = new Map<string, CentralPursuitObservation[]>();

  for (const row of observations) {
    const key = centralPursuitFamilyKey(row.scope, row.objective, row.conditionRef);
    const history = histories.get(key) ?? [];
    history.push(row);
    histories.set(key, history);
  }

  const predictions: CentralPursuitPrediction[] = [];

  for (const candidate of candidates) {
    const { opportunity, objective } = candidate;
    const key = centralPursuitFamilyKey(opportunity.scope, objective, opportunity.conditionRef);
    const history = histories.get(key) ?? [];
    const qualified = history.filter(row => row.outcome === "qualified").length;
    const noResult = history.filter(row => row.outcome === "closed_no_result").length;
    const pending = history.length - qualified - noResult;

    if (objective.resourceModel !== undefined) {
      // The canonical v2 observation guard requires a treatment whenever this
      // family declares a resource model; legacy flat families have another key.
      const resource = fitCentralPursuitResourceModel(history.map(row => ({ treatmentRef: row.treatmentRef!, outcome: row.outcome })),
        centralPursuitTreatmentRef(opportunity.offer));
      if (resource.status !== "ready") return resource;

      predictions.push({ opportunityId: opportunity.opportunityId, objective, model: "resource_model_average_v1",
        interpretation: "declared_objective_completion_not_economic_gain", qualified, noResult, pending,
        posteriorAlpha: resource.belief.shared.alpha, posteriorBeta: resource.belief.shared.beta,
        mean: resource.mean, variance: resource.variance, pendingMeanRange: resource.pendingMeanRange,
        support: qualified + noResult === 0 ? "reference_prior" : "updated_reference_model",
        sourceRefs: [...new Set([REFERENCE_SOURCE, objective.familySourceRef, objective.resourceModel.sourceRef,
          ...resource.sourceRefs, ...history.flatMap(row => [row.sourceRef, row.revisionRef])])], resourceModel: resource.belief });
      continue;
    }

    const result = predictBetaBinomialDemand({ targetKey: key, referenceUnit: "independent_declared_stage_objectives",
      sourceRef: objective.familySourceRef, prior: { alpha: 1 / 2, beta: 1 / 2, sourceRef: REFERENCE_SOURCE },
      n: qualified + noResult, k: qualified, horizon: 1 });
    if (result.status !== "ready") return { status: "invalid", reason: result.reason };

    const posterior = result.value, completedTotal = posterior.posteriorAlpha + posterior.posteriorBeta + pending;

    predictions.push({ opportunityId: opportunity.opportunityId, objective, model: MODEL,
      interpretation: "declared_objective_completion_not_economic_gain", qualified, noResult, pending,
      posteriorAlpha: posterior.posteriorAlpha, posteriorBeta: posterior.posteriorBeta,
      mean: posterior.mean, variance: posterior.rateVariance,
      pendingMeanRange: [posterior.posteriorAlpha / completedTotal, (posterior.posteriorAlpha + pending) / completedTotal],
      support: qualified + noResult === 0 ? "reference_prior" : "updated_reference_model",
      sourceRefs: [...new Set([REFERENCE_SOURCE, objective.familySourceRef,
        ...history.flatMap(row => [row.sourceRef, row.revisionRef])])],
    });
  }

  const inputProjection = candidates.map(candidate => ({ opportunity: candidate.opportunity,
    objective: candidate.objective, purpose: candidate.purpose }));
  const modelRef = `central-pursuit-prediction:${contentHashOf({ model: MODEL, basis,
    referenceSource: REFERENCE_SOURCE, candidates: inputProjection, observations, predictions, assumptions })}`;

  return { status: "ready", predictions, modelRef, assumptions };
}

/** Counterfactual observations are local planning branches, never source facts.
 * This keeps posterior model weights and exact-treatment rates inside Bellman,
 * rather than reporting resource uncertainty only as a diagnostic. */
export function centralPursuitConditionalProbability(prediction: CentralPursuitPrediction,
  observations: readonly { readonly treatmentRef: string; readonly outcome: 0 | 1 }[]):
  { readonly status: "ready"; readonly mean: number } | { readonly status: "invalid" | "unsupported"; readonly reason: string } {
  if (prediction.resourceModel === undefined) {
    const alpha = prediction.posteriorAlpha + observations.filter(row => row.outcome === 1).length;
    const beta = prediction.posteriorBeta + observations.filter(row => row.outcome === 0).length;
    return { status: "ready", mean: alpha / (alpha + beta) };
  }

  let belief = prediction.resourceModel;

  for (const observation of observations) {
    const next = advanceCentralPursuitResourceModel(belief, observation);
    if (next.status !== "ready") return next;
    belief = next.belief;
  }

  const result = predictCentralPursuitResourceModel(belief, prediction.resourceModel.treatmentRef);

  return result.status === "ready" ? { status: "ready", mean: result.mean } : result;
}
