import { fields } from "../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isAllocationBasis } from "../../learning/control/allocation-shape.js";
import { validCentralPursuitInput } from "../../learning/control/decision/pursuit-input.js";
import { decideCentralLearningPursuit } from "../../learning/control/decision/pursuit-model.js";
import type { CentralPursuitInput } from "../../learning/control/decision/pursuit-contract.js";
import { readCentralPursuitObservations } from "./pursuit-observations.js";
import { lookupCentralResponseEvidence } from "./response-discovery.js";
import type { CentralResponseDiscoveryBinding, CentralResponseDiscoveryResult } from "./response-discovery.js";
import { resolveCentralResponseContexts } from "./response-context.js";
import { assessCentralEconomicEvidence } from "./economic-evidence.js";
import type { CentralEconomicNegativeEvidence, CentralEconomicEvidenceAssessment, CentralConditionalResponseDiagnostic } from "./economic-evidence.js";
import type { CentralEconomicStageBinding, CentralLearningEvidenceInput, CentralLearningEvidenceResult } from "./evidence-decision-contract.js";

export type { CentralLearningEvidenceInput, CentralLearningEvidenceResult, CentralLearningDispatchDecision,
  CentralLearningDispatchStep, CentralEconomicStageBinding } from "./evidence-decision-contract.js";
export { resolveCentralResponseContexts } from "./response-context.js";
export type { CentralResponseContext, CentralResponseContextBinding } from "./response-context.js";

function sourceBinding(binding: CentralEconomicStageBinding): CentralResponseDiscoveryBinding {
  const { timingTarget: _timing, fee: _fee, ...source } = binding;
  return source;
}

function pursuit(input: CentralPursuitInput, discovery: Extract<CentralResponseDiscoveryResult, { status: "ready" }>,
  sourceRefs: readonly string[], reasons: readonly string[], economicConstraints: readonly CentralEconomicNegativeEvidence[] = [],
  conditionalResponses: readonly CentralConditionalResponseDiagnostic[] = []): CentralLearningEvidenceResult {
  const valuation = decideCentralLearningPursuit(input);
  return valuation.status === "rejected" ? valuation : { status: "decided", mode: "stage_objective_pursuit",
    decisionRef: `central-evidence-decision:${contentHashOf({ valuationRef: valuation.decisionRef, discovery,
      sourceRefs, reasons, economicConstraints, conditionalResponses })}`, basis: valuation.basis, nextStep: valuation.nextStep, valuation, discovery,
    reasons: [...new Set(reasons)], sourceRefs, economicConstraints, conditionalResponses };
}

function economic(assessment: CentralEconomicEvidenceAssessment,
  discovery: Extract<CentralResponseDiscoveryResult, { status: "ready" }>, conditionalResponses: readonly CentralConditionalResponseDiagnostic[]): CentralLearningEvidenceResult {
  return { status: "decided", mode: "economic_response", decisionRef: assessment.decision.decisionRef,
    basis: assessment.input.prediction.basis, nextStep: assessment.actions.nextStep,
    valuation: assessment.decision, discovery, sourceRefs: assessment.source.sourceRefs, conditionalResponses };
}

/** The normal source -> numerical model -> decision entry. Economic response and
 * qualified stage-objective pursuit retain different units and assumptions. A
 * missing effect history activates a bounded first learning stage, not fake gain. */
export function decideCentralLearningWithEvidence(input: CentralLearningEvidenceInput): CentralLearningEvidenceResult {
  if (!(fields(input, ["schemaVersion", "board", "basis", "candidates", "horizon"])
    || fields(input, ["schemaVersion", "board", "basis", "candidates", "horizon", "valueBindings"])
    || fields(input, ["schemaVersion", "board", "basis", "candidates", "horizon", "responseContexts"])
    || fields(input, ["schemaVersion", "board", "basis", "candidates", "horizon", "valueBindings", "responseContexts"]))
    || !isAllocationBasis(input.basis)) {
    return { status: "rejected", reason: "central_evidence_decision_input" };
  }

  const observed = readCentralPursuitObservations(input.board, input.basis.scope);
  if (observed.status !== "ready") return { status: "rejected", reason: observed.reason };

  const pursuitInput: CentralPursuitInput = { schemaVersion: input.schemaVersion, board: input.board, basis: input.basis,
    candidates: input.candidates, horizon: input.horizon, observations: observed.observations };
  if (!validCentralPursuitInput(pursuitInput)) return { status: "rejected", reason: "central_evidence_decision_input" };

  const contexts = resolveCentralResponseContexts({ board: input.board, scope: input.basis.scope,
    candidates: input.candidates, contexts: input.responseContexts ?? [] });
  if (contexts.status !== "ready") return { status: "rejected", reason: contexts.reason };

  const explicit = input.valueBindings ?? [];
  if (!Array.isArray(explicit) || explicit.length > 30 || !explicit.every(binding => binding !== null
    && typeof binding === "object" && !Array.isArray(binding))) return { status: "rejected", reason: "central_economic_bindings" };

  const bindings: CentralResponseDiscoveryBinding[] = explicit.map(sourceBinding);

  for (const automatic of contexts.bindings) {
    const previous = bindings.find(row => row.opportunityId === automatic.opportunityId);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(automatic)) {
      return { status: "rejected", reason: "central_economic_binding_conflict" };
    }
    if (previous === undefined) bindings.push(automatic);
  }

  const discovery = lookupCentralResponseEvidence({ board: input.board, scope: input.basis.scope,
    candidates: input.candidates, bindings });
  if (discovery.status !== "ready") return { status: "rejected", reason: discovery.reason };

  const reasons = [...contexts.unmatched.map(row => row.reason), ...discovery.unmatched.map(row => row.reason)];
  const assessed = assessCentralEconomicEvidence(input, discovery);
  if (assessed.status !== "ready") return assessed;

  const negative = new Set(assessed.negative.map(row => row.opportunityId));
  // Do not switch an identified negative economic investment into a positive
  // proposal-count score merely because another source lacks effect history.
  const cleanup = assessed.assessments.find(item => item.actions.nextStep.kind === "end_investment"
    && negative.has(item.actions.nextStep.evaluation.candidate.opportunity.opportunityId));
  if (cleanup !== undefined) return economic(cleanup, discovery, assessed.conditionalResponses);

  const full = assessed.assessments.filter(item => input.candidates.length > 0
    && item.input.prediction.opportunities.length === input.candidates.length && item.source.identifiedOpportunityIds.length > 0);
  if (full.length > 1) return { status: "rejected", reason: "economic_target_ambiguous" };

  if (full.length === 1) {
    const value = full[0]!;
    const unresolvedLearning = value.decision.evaluations.filter(row => !negative.has(row.opportunityId)
      && row.query !== null && (row.query.variance === null || row.query.variance > 0)
      && row.timing?.status === "ready" && row.timing.advice === "stop")
      .map(row => row.opportunityId);

    // Exact zero with genuine remaining uncertainty is not a permanently
    // unidentified variance gate. A bounded, explicitly labelled learning
    // objective may still obtain its first discriminating result.
    if (unresolvedLearning.length === 0 || (value.actions.nextStep.kind !== "stop" && value.actions.nextStep.kind !== "wait")) {
      return economic(value, discovery, assessed.conditionalResponses);
    }

    const allowed = new Set(unresolvedLearning);

    return pursuit({ ...pursuitInput, candidates: input.candidates.filter(row => allowed.has(row.opportunity.opportunityId)) },
      discovery, [observed.sourceRef, ...assessed.sourceRefs], [...reasons, "bounded_learning_with_unresolved_economic_response"], assessed.negative, assessed.conditionalResponses);
  }

  return pursuit({ ...pursuitInput, candidates: input.candidates.filter(row => !negative.has(row.opportunity.opportunityId)) },
    discovery, [observed.sourceRef, ...assessed.sourceRefs], [...reasons, ...assessed.unusable.map(row => row.reason),
      "economic_common_target_not_identified", ...assessed.negative.map(row => `identified_negative_economic_stage:${row.opportunityId}`)], assessed.negative, assessed.conditionalResponses);
}
