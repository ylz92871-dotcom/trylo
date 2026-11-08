import { fields, identity, sequence } from "../../../validation/json-shape.js";
import { allocationCapKey, allocationFits, isAllocationResources } from "../allocation-shape.js";
import { centralBudgetProjection } from "../central-budget-state.js";
import { isCentralLearningAllowance } from "../coordination-parse.js";
import { contentHashOf } from "../hash.js";
import { planSequentialAllocation } from "../sequential-allocation.js";
import type { SequentialAllocationRequest, SequentialAllocationState } from "../sequential-allocation-contract.js";
import type { CentralDecisionEvaluation, CentralDecisionInput, CentralDecisionRequirement, CentralDecisionResult } from "./decision-contract.js";
import { buildCentralResponseForecast } from "./prediction-model.js";
import type { CentralResponseForecast, CentralResponseProducer } from "./prediction-input.js";
import { isCentralDecisionStageSource, projectCentralDecisionStage } from "./stage-projection.js";
import { analyzeCentralOpportunityTiming } from "./timing-model.js";
import { centralResponseTimingTarget } from "./response-timing.js";

const replanOn = ["effective_feedback_revision", "source_or_policy_revision", "confirmed_stage_boundary",
  "usage_settlement_and_reconcile", "board_prefix_or_budget_change", "business_boundary_or_use_window_change"] as const;

function validEnvelope(input: CentralDecisionInput): boolean {
  return fields(input, ["schemaVersion", "board", "prediction", "candidates"]) && input.schemaVersion === 1
    && input.board !== null && typeof input.board === "object" && sequence(input.board.sequence)
    && Array.isArray(input.candidates) && input.candidates.length <= 30
    && input.candidates.every(row => fields(row, ["opportunityId", "source", "readiness", "target", "fee"])
      && identity(row.opportunityId) && isCentralDecisionStageSource(row.source))
    && new Set(input.candidates.map(row => row.opportunityId)).size === input.candidates.length;
}

/** Source readiness constrains the numerical model, never the other way around. */
function evaluateCandidates(input: CentralDecisionInput, forecast: CentralResponseForecast): readonly CentralDecisionEvaluation[] {
  return input.candidates.map(candidate => {
    const opportunity = input.prediction.opportunities.find(row => row.opportunityId === candidate.opportunityId)!;
    const query = forecast.queries.find(row => row.opportunityId === candidate.opportunityId) ?? null;
    const stage = projectCentralDecisionStage({ ...candidate.source, board: input.board,
      scope: forecast.basis.scope, budgetId: forecast.basis.budgetId, offer: opportunity.offer });
    if ((stage.status !== "ready" && stage.status !== "continue_existing" && stage.status !== "reconcile_then_replan")
      || query === null) return { opportunityId: candidate.opportunityId, query, stage, timing: null };

    const timing = analyzeCentralOpportunityTiming({ schemaVersion: 1, opportunityId: query.opportunityId,
      windowRef: query.windowRef, forecastRef: forecast.forecastRef, mean: query.mean, basis: forecast.basis,
      offer: query.offer, readiness: candidate.readiness, target: centralResponseTimingTarget(query, candidate.target), fee: candidate.fee });

    return { opportunityId: candidate.opportunityId, query, stage, timing };
  });
}

function requirementsFor(forecast: CentralResponseForecast, evaluations: readonly CentralDecisionEvaluation[]): CentralDecisionRequirement[] {
  const requirements: CentralDecisionRequirement[] = [...forecast.requirements];

  for (const row of evaluations) {
    if (row.stage.status !== "ready" && row.stage.status !== "terminal") {
      requirements.push({ opportunityId: row.opportunityId, reason: row.stage.status, sourceRefs: [row.stage.sourceBindingRef] });
    }
    if (row.timing?.status === "ready") {
      for (const reason of row.timing.requirements) requirements.push({ opportunityId: row.opportunityId, reason,
        sourceRefs: row.timing.sourceRefs });
    }
  }

  return requirements;
}

type Investable = CentralDecisionEvaluation & { readonly query: NonNullable<CentralDecisionEvaluation["query"]>;
  readonly timing: Extract<NonNullable<CentralDecisionEvaluation["timing"]>, { status: "ready" }> };

function investable(row: CentralDecisionEvaluation): row is Investable {
  return row.stage.status === "ready" && row.query !== null && row.timing?.status === "ready"
    && (row.timing.advice === "now" || row.timing.advice === "defer") && row.timing.netValue !== null;
}

/** A deterministic no-signal completion has an expected terminal value, not an observed
 * quality label. No hidden success branch, refund, additive multi-owner gain or variance
 * exploration bonus is manufactured. A new observation always returns to this entrypoint. */
function allocationRequest(forecast: CentralResponseForecast, remaining: SequentialAllocationRequest["remaining"],
  rows: readonly Investable[], valuationRef: string): SequentialAllocationRequest {
  const terminal: SequentialAllocationState[] = rows.map((row, index) => ({ stateId: `after-stage-${index}`,
    stopValue: row.timing.netValue!, offers: [] }));
  return { schemaVersion: 1, modelKind: "declared_finite_observable", basis: { ...forecast.basis, valuationRef },
    initialStateId: "current-boundary", remaining, horizon: 1,
    states: [{ stateId: "current-boundary", stopValue: 0, offers: rows.map((row, index) => ({ offer: row.query.offer,
      outcomes: [{ probability: 1, cost: row.query.offer.reserve, utilityCost: 0, nextStateId: terminal[index]!.stateId }] })) }, ...terminal] };
}

function idleRecommendation(rows: readonly CentralDecisionEvaluation[], requirements: readonly CentralDecisionRequirement[]):
  Extract<CentralDecisionResult, { status: "decided" }>["recommendation"] {
  if (rows.some(row => row.stage.status === "reconcile_then_replan" || row.stage.status === "continue_existing")) return "reconcile_then_replan";
  if (rows.some(row => row.stage.status === "in_flight")) return "in_flight";
  return requirements.length === 0 ? "stop" : "wait_evidence";
}

/** The actual composition seam: source history -> posterior -> timing family ->
 * shared-budget first-stage selection -> original allocator application JSON.
 * One macro-stage is chosen because separate marginal forecasts do not identify a
 * joint/adaptive multi-stage law. This is receding observation, not a runtime loop. */
export function decideCentralLearning(input: CentralDecisionInput,
  predict: CentralResponseProducer = buildCentralResponseForecast): CentralDecisionResult {
  if (!validEnvelope(input)) return { status: "rejected", reason: "central_decision_input" };

  if (input.prediction?.target?.estimand !== "learning_policy_response") return {
    status: "rejected", reason: "central_decision_learning_policy_estimand_required" };

  const predicted = predict(input.prediction);
  if (predicted.status !== "ready") return { status: "rejected", reason: predicted.reason };

  const forecast = predicted.value;

  if (input.prediction.opportunities.some(({ offer }) => !isCentralLearningAllowance({ schemaVersion: 2,
    unit: "total_model_tokens", maxTokens: offer.reserve.tokens, maxCalls: offer.reserve.calls,
    maxSteps: offer.reserve.steps, maxPromptChars: offer.maxPromptChars }))) {
    return { status: "rejected", reason: "central_decision_provider_envelope_required" };
  }

  if (input.board.sequence !== forecast.basis.boardSequence) return { status: "rejected", reason: "central_decision_stale_basis" };

  if (input.candidates.length !== input.prediction.opportunities.length || input.candidates.some(candidate => {
    const query = input.prediction.opportunities.find(row => row.opportunityId === candidate.opportunityId);
    return query === undefined || query.stage !== candidate.source.domainStage.kind
      || query.instanceRef !== candidate.source.domainStage.stageRef;
  })) return { status: "rejected", reason: "central_decision_candidate_binding" };

  const budget = centralBudgetProjection(input.board, forecast.basis.budgetId);
  if (budget === undefined || budget.budget.scope !== forecast.basis.scope || budget.status === "held") {
    return { status: "rejected", reason: "central_decision_budget_unavailable" };
  }

  // Restrict a large root to the established numerical window, never enlarge it.
  const remaining = { tokens: budget.available.tokens, calls: Math.min(1024, budget.available.calls),
    steps: Math.min(1024, budget.available.steps) };
  if (!isAllocationResources(remaining)) return { status: "rejected", reason: "central_decision_budget_shape" };

  const evaluations = evaluateCandidates(input, forecast);
  const failure = evaluations.find(row => row.timing?.status === "rejected");
  if (failure?.timing?.status === "rejected") return { status: "rejected", reason: failure.timing.reason };

  const rows = evaluations.filter(investable), caps = new Set(rows.map(row => allocationCapKey(row.query.offer)));
  if (caps.size !== rows.length) return { status: "rejected", reason: "central_decision_canonical_policy_required" };

  const requirements = requirementsFor(forecast, evaluations);

  for (const row of rows.filter(row => !allocationFits(row.query.offer.reserve, remaining))) requirements.push({
    opportunityId: row.opportunityId, reason: "current_resources_insufficient", sourceRefs: [forecast.basis.budgetId] });

  const decisionRef = `central-decision:${contentHashOf({ forecast, remaining, evaluations, replanOn })}`;
  const request = allocationRequest(forecast, remaining, rows, decisionRef), proposalJson = JSON.stringify(request);
  const result = planSequentialAllocation(proposalJson);
  if (result.status !== "planned") return { status: "rejected", reason: result.reason };

  const chosen = result.plan.decision;
  const selected = chosen.kind === "stop" ? null : rows.find(row => row.query.offer.offerId === chosen.offer.offerId)!;
  const recommendation = selected === null ? idleRecommendation(evaluations, requirements)
    : selected.timing.advice === "now" ? "now" : "defer";

  return { status: "decided", decisionRef, forecast, remaining, evaluations, requirements, plan: result.plan,
    recommendation, selected, application: recommendation === "now" ? { kind: "sequential", proposalJson } : null,
    scope: "one_macro_stage_then_reobserve", replanOn };
}
