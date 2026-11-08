import { isAllocationBasis } from "../../learning/control/allocation-shape.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { decideCentralLearning } from "../../learning/control/decision/decision-model.js";
import type { CentralDecisionInput } from "../../learning/control/decision/decision-contract.js";
import type { CentralResponseForecast, CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import { enumerateCentralTimingPrograms } from "../../learning/control/decision/timing-model.js";
import { centralResponseTimingTarget } from "../../learning/control/decision/response-timing.js";
import { identity, sequence } from "../../validation/json-shape.js";
import { buildCentralResponseEvidenceForecast, type CentralResponseEvidenceForecastResult } from "./response-forecast.js";
import { chooseCentralEconomicStep, type CentralEconomicActionResult, type ReadyCentralDecisionResult } from "./economic-actions.js";
import type { CentralLearningEvidenceInput } from "./evidence-decision-contract.js";
import type { CentralResponseDiscoveryGroup, CentralResponseDiscoveryResult } from "./response-discovery.js";

type ReadyDiscovery = Extract<CentralResponseDiscoveryResult, { status: "ready" }>;

type ReadySource = Extract<CentralResponseEvidenceForecastResult, { status: "ready" }>;

export type CentralEconomicEvidenceAssessment = {
  readonly source: ReadySource; readonly input: CentralDecisionInput;
  readonly decision: ReadyCentralDecisionResult;
  readonly actions: Extract<CentralEconomicActionResult, { status: "ready" }>;
};

export type CentralEconomicNegativeEvidence = { readonly opportunityId: string; readonly targetKey: string;
  readonly interpretation: "negative_current_model_expectation" | "source_supported_negative_net_ceiling";
  readonly utilityUnit: string; readonly netValue: number; readonly sourceRefs: readonly string[];
  readonly modelAssumptions: readonly string[] };

export type CentralEconomicEvidenceGap = { readonly targetKey: string; readonly opportunityIds: readonly string[];
  readonly reason: string; readonly sourceRefs: readonly string[] };

export type CentralConditionalResponseDiagnostic = { readonly target: CentralResponseTarget; readonly forecast: CentralResponseForecast;
  readonly reason: "deployment_response_not_learning_policy_response";
  readonly opportunityIds: readonly string[]; readonly sourceRefs: readonly string[] };

export type CentralEconomicEvidenceResult = { readonly status: "ready";
  readonly assessments: readonly CentralEconomicEvidenceAssessment[]; readonly negative: readonly CentralEconomicNegativeEvidence[];
  readonly sourceRefs: readonly string[]; readonly unusable: readonly CentralEconomicEvidenceGap[];
  readonly conditionalResponses: readonly CentralConditionalResponseDiagnostic[] }
  | { readonly status: "rejected"; readonly reason: string };

function candidateSubset(input: CentralLearningEvidenceInput, group: CentralResponseDiscoveryGroup):
  { readonly status: "ready"; readonly candidates: CentralDecisionInput["candidates"];
    readonly originals: CentralLearningEvidenceInput["candidates"] }
  | { readonly status: "unusable"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string } {
  const originals: CentralLearningEvidenceInput["candidates"][number][] = [];
  const candidates: CentralDecisionInput["candidates"][number][] = [];

  if (new Set(group.opportunities.map(row => row.opportunityId)).size !== group.opportunities.length) {
    return { status: "rejected", reason: "economic_evidence_candidate_binding" };
  }

  for (const mapped of group.opportunities) {
    const original = input.candidates.find(row => row.opportunity.opportunityId === mapped.opportunityId);
    if (original === undefined || original.opportunity.scope !== mapped.scope
      || original.opportunity.instanceRef !== mapped.instanceRef || original.opportunity.sourceRef !== mapped.sourceRef
      || original.opportunity.stage !== mapped.stage || contentHashOf(original.opportunity.offer) !== contentHashOf(mapped.offer)) {
      return { status: "rejected", reason: "economic_evidence_candidate_binding" };
    }

    const binding = input.valueBindings?.find(row => row.opportunityId === mapped.opportunityId);
    if (original.fee.kind === "utility" && binding?.fee === undefined) {
      return { status: "unusable", reason: "economic_fee_unit_binding_required" };
    }

    originals.push(original);
    candidates.push({ opportunityId: mapped.opportunityId, source: original.source, readiness: original.readiness,
      target: binding?.timingTarget ?? original.target, fee: binding?.fee ?? original.fee });
  }

  return { status: "ready", candidates, originals };
}

/** A certified idle choice alone says nothing about a negative processing value.
 * Retain identified model negatives or a source-supported actual net ceiling.
 * Missing programs, unresolved upper families and exact zero remain open;
 * pending completion ranges are working-model ranges, never confidence bounds. */
function negativeEvidence(assessment: CentralEconomicEvidenceAssessment): readonly CentralEconomicNegativeEvidence[] {
  const { source, input, decision } = assessment, negative: CentralEconomicNegativeEvidence[] = [];

  for (const row of decision.evaluations) {
    if (row.query === null || row.timing?.status !== "ready" || row.timing.advice !== "stop" || row.timing.analysis === null
      || !row.timing.analysis.firstControlCertificate.nonInferior.includes("no_more_processing")) continue;

    const candidate = input.candidates.find(item => item.opportunityId === row.opportunityId)!;
    const menu = enumerateCentralTimingPrograms({ schemaVersion: 1, opportunityId: row.opportunityId,
      windowRef: row.query.windowRef, forecastRef: decision.forecast.forecastRef, mean: row.query.mean,
      basis: decision.forecast.basis, offer: row.query.offer, readiness: candidate.readiness,
      target: centralResponseTimingTarget(row.query, candidate.target), fee: candidate.fee });
    if (menu.status !== "ready" || menu.unresolvedStarts.length !== 0 || menu.programs.length === 0) continue;

    const best = Math.max(...menu.programs.map(program => program.grossMean - program.utilityFee));
    let modelNegative = source.identifiedOpportunityIds.includes(row.opportunityId) && best < 0;
    if (modelNegative && (row.query.pending ?? 0) > 0) {
      const range = row.query.pendingMeanRange;
      // Completion censoring can replace gross with zero, while every source-
      // declared processing fee remains payable. Compare in the same economic unit.
      const upperGross = range === undefined ? null : candidate.target.kind === "deadline" ? Math.max(0, range[1]) : range[1];
      modelNegative = range !== undefined && range.every(Number.isFinite) && range[0] <= range[1]
        && upperGross !== null && menu.programs.every(program => upperGross < program.utilityFee);
    }

    // This is an actual outcome support supplied by the source, not a negative
    // prior mean or posterior interval. It also constrains unrevealed episodes.
    const support = row.query.grossSupport;
    const upperGross = support === undefined ? null : candidate.target.kind === "deadline" ? Math.max(0, support.maximum) : support.maximum;
    const sourceNegative = support !== undefined && Number.isFinite(support.minimum) && Number.isFinite(support.maximum)
      && support.minimum <= support.maximum && identity(support.sourceRef) && source.sourceRefs.includes(support.sourceRef)
      && upperGross !== null && menu.programs.every(program => upperGross < program.utilityFee);
    if (!modelNegative && !sourceNegative) continue;

    negative.push({ opportunityId: row.opportunityId, targetKey: input.prediction.target.key,
      interpretation: modelNegative ? "negative_current_model_expectation" : "source_supported_negative_net_ceiling",
      utilityUnit: input.prediction.target.utilityUnit, netValue: modelNegative ? best
        : Math.max(...menu.programs.map(program => upperGross! - program.utilityFee)),
      modelAssumptions: decision.forecast.modelAssumptions ?? [],
      sourceRefs: [...new Set([...source.sourceRefs, ...row.query.sourceRefs, ...row.timing.sourceRefs,
        ...(sourceNegative ? [support!.sourceRef] : [])])] });
  }

  return negative;
}

/** Assess every discovered target on its actual mapped subset. Targets/currencies
 * are never added together, and model-only priors never become observed negatives. */
export function assessCentralEconomicEvidence(input: CentralLearningEvidenceInput, discovery: ReadyDiscovery): CentralEconomicEvidenceResult {
  if (!isAllocationBasis(input.basis) || !sequence(input.board?.sequence) || input.board.sequence !== input.basis.boardSequence
    || !Array.isArray(input.candidates) || input.candidates.length > 30
    || new Set(input.candidates.map(row => row.opportunity.opportunityId)).size !== input.candidates.length
    || discovery.status !== "ready" || !Array.isArray(discovery.groups) || discovery.groups.length > 30
    || input.valueBindings !== undefined && (!Array.isArray(input.valueBindings)
      || input.valueBindings.length > 30 || !input.valueBindings.every(row => row !== null && typeof row === "object"
        && identity(row.opportunityId)) || new Set(input.valueBindings.map(row => row.opportunityId)).size !== input.valueBindings.length)) {
    return { status: "rejected", reason: "economic_evidence_input" };
  }

  const assessments: CentralEconomicEvidenceAssessment[] = [], negative: CentralEconomicNegativeEvidence[] = [];
  const unusable: CentralEconomicEvidenceGap[] = [], sourceRefs = new Set<string>();
  const conditionalResponses: CentralConditionalResponseDiagnostic[] = [];
  const groups: readonly CentralResponseDiscoveryGroup[] = discovery.groups;

  for (const group of groups) {
    const source = buildCentralResponseEvidenceForecast({ board: input.board,
      basis: { ...input.basis, utilityUnit: group.target.utilityUnit }, group });
    if (source.status !== "ready") return { status: "rejected", reason: source.reason };

    for (const ref of source.sourceRefs) sourceRefs.add(ref);

    // Deployment-selected observations do not identify the whole learning
    // policy's effect. Neither their mean nor hard support may cross this seam.
    if (group.target.estimand !== "learning_policy_response") {
      const reason = "deployment_response_not_learning_policy_response" as const;
      const opportunityIds = group.opportunities.map(row => row.opportunityId);
      conditionalResponses.push({ target: group.target, forecast: source.forecast, opportunityIds, reason, sourceRefs: source.sourceRefs });
      unusable.push({ targetKey: group.target.key, opportunityIds, reason, sourceRefs: source.sourceRefs });
      continue;
    }

    const subset = candidateSubset(input, group);
    if (subset.status === "rejected") return subset;

    if (subset.status === "unusable") {
      for (const row of group.registrations) sourceRefs.add(row.factId);
      unusable.push({ targetKey: group.target.key, opportunityIds: group.opportunities.map(row => row.opportunityId),
        reason: subset.reason, sourceRefs: group.registrations.map(row => row.factId) });
      continue;
    }

    const economicInput: CentralDecisionInput = { schemaVersion: 1, board: input.board, prediction: source.input, candidates: subset.candidates };
    const decision = decideCentralLearning(economicInput, source.predict);
    if (decision.status !== "decided") return decision;

    const actions = chooseCentralEconomicStep(economicInput, decision, subset.originals, source.predict);
    if (actions.status !== "ready") return actions;

    const assessment = { source, input: economicInput, decision, actions };

    assessments.push(assessment);
    negative.push(...negativeEvidence(assessment));
  }

  return { status: "ready", assessments, negative, unusable, sourceRefs: [...sourceRefs], conditionalResponses };
}
