import { contentHashOf } from "../../learning/control/hash.js";
import { decideCentralLearning } from "../../learning/control/decision/decision-model.js";
import { simulateCentralReconcile } from "../../learning/control/decision/reconcile-option.js";
import type { CentralDecisionEvaluation, CentralDecisionInput, CentralDecisionResult } from "../../learning/control/decision/decision-contract.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import type { CentralResponseProducer } from "../../learning/control/decision/prediction-input.js";
import type { CentralLearningDispatchEvaluation, CentralLearningDispatchStep } from "./evidence-decision-contract.js";

export type ReadyCentralDecisionResult = Extract<CentralDecisionResult, { status: "decided" }>;

export type CentralEconomicOption = { readonly kind: "new_backlog" | "covered_prefix" | "conditional_reconcile";
  readonly grantId: string | null; readonly value: number; readonly modelRefs: readonly string[] };

export type CentralEconomicActionResult = { readonly status: "ready"; readonly nextStep: CentralLearningDispatchStep;
  readonly options: readonly CentralEconomicOption[] } | { readonly status: "rejected"; readonly reason: string };

type Choice = { readonly option: CentralEconomicOption; readonly step: CentralLearningDispatchStep };

function dispatchEvaluation(row: CentralDecisionEvaluation, originals: readonly CentralPursuitCandidate[], input: CentralDecisionInput): CentralLearningDispatchEvaluation | null {
  const original = originals.find(candidate => candidate.opportunity.opportunityId === row.opportunityId);
  const opportunity = row.query ?? input.prediction.opportunities.find(candidate => candidate.opportunityId === row.opportunityId);
  if (original === undefined || opportunity === undefined || original.opportunity.instanceRef !== opportunity.instanceRef
    || original.source.grantId !== row.stage.grantId || original.source.issueId !== row.stage.issueId
    || original.source.sourceBindingRef !== row.stage.sourceBindingRef
    || contentHashOf(original.opportunity.offer) !== contentHashOf(opportunity.offer)) return null;

  return { candidate: original, stage: row.stage, timing: row.timing };
}

function unknownCompetition(rows: readonly CentralDecisionEvaluation[]): boolean {
  return rows.some(row => row.stage.status !== "terminal" && (row.query === null
    || ["needs_source", "in_flight", "waiting_evidence"].includes(row.stage.status)
    || row.timing === null || row.timing.status !== "ready" || row.timing.advice === "requires_model"
    || row.timing.advice === "wait_evidence" || row.timing.advice === "in_flight"));
}

function idleStep(input: CentralDecisionInput, decision: ReadyCentralDecisionResult, originals: readonly CentralPursuitCandidate[]): CentralLearningDispatchStep {
  if (!unknownCompetition(decision.evaluations)) {
    const covered = decision.evaluations.find(row => row.stage.status === "continue_existing"
      && row.timing?.status === "ready" && row.timing.advice === "stop");
    if (covered !== undefined) {
      const evaluation = dispatchEvaluation(covered, originals, input);
      if (evaluation !== null) return { kind: "end_investment", evaluation, reason: "economic_model_has_no_positive_known_continuation" };
    }
  }

  if (decision.requirements.length > 0 || decision.evaluations.some(row => row.stage.status !== "ready" && row.stage.status !== "terminal")) {
    return { kind: "wait", reasons: [...new Set(decision.requirements.map(row => row.reason))],
      sourceRefs: [...new Set(decision.requirements.flatMap(row => row.sourceRefs))] };
  }

  return { kind: "stop" };
}

/** Compare current economic values only. Pursuit predictions never enter this
 * currency. A conditional release is returned for real execution/replanning,
 * never treated as money already available for a new funding application. */
export function chooseCentralEconomicStep(input: CentralDecisionInput, decision: ReadyCentralDecisionResult,
  originals: readonly CentralPursuitCandidate[], predict: CentralResponseProducer): CentralEconomicActionResult {
  if (input.prediction.target.estimand !== "learning_policy_response"
    || decision.forecast.target.estimand !== "learning_policy_response") return {
    status: "rejected", reason: "economic_action_learning_policy_estimand_required" };

  if (decision.forecast.basis.boardSequence !== input.board.sequence || input.prediction.basis.boardSequence !== input.board.sequence
    || decision.forecast.basis.scope !== input.prediction.basis.scope || decision.forecast.basis.budgetId !== input.prediction.basis.budgetId
    || decision.forecast.basis.utilityUnit !== input.prediction.basis.utilityUnit
    || new Set(originals.map(row => row.opportunity.opportunityId)).size !== originals.length) {
    return { status: "rejected", reason: "economic_action_binding" };
  }

  const options: CentralEconomicOption[] = [{ kind: "new_backlog", grantId: null, value: decision.plan.netGain,
    modelRefs: [decision.plan.modelHash] }];
  const choices: Choice[] = [];

  if (decision.selected !== null && decision.plan.decision.kind === "offer") {
    const evaluation = dispatchEvaluation(decision.selected, originals, input);
    if (evaluation === null || (decision.recommendation !== "now" && decision.recommendation !== "defer")
      || decision.recommendation === "now" && decision.application === null) return { status: "rejected", reason: "economic_action_selected_source" };
    choices.push({ option: options[0]!, step: decision.recommendation === "defer" ? { kind: "defer", evaluation }
      : { kind: "fund_and_dispatch", evaluation, application: decision.application } });
  }

  const examined = new Set<string>();

  for (const row of decision.evaluations) {
    if (row.stage.status !== "continue_existing" && row.stage.status !== "reconcile_then_replan") continue;

    const evaluation = dispatchEvaluation(row, originals, input);
    if (evaluation === null) return { status: "rejected", reason: "economic_action_existing_source" };

    if (row.stage.status === "continue_existing" && row.query !== null && row.timing?.status === "ready"
      && (row.timing.advice === "now" || row.timing.advice === "defer") && row.timing.netValue !== null) {
      const option: CentralEconomicOption = { kind: "covered_prefix", grantId: row.stage.grantId,
        value: row.timing.netValue, modelRefs: [decision.forecast.forecastRef, row.query.parameterRef,
          ...(row.timing.analysis === null ? [] : [row.timing.analysis.modelHash])] };
      options.push(option);
      choices.push({ option, step: row.timing.advice === "defer" ? { kind: "defer", evaluation }
        : { kind: "dispatch_existing", evaluation, application: null } });
    }

    if (examined.has(row.stage.grantId)) continue;

    examined.add(row.stage.grantId);
    const simulated = simulateCentralReconcile(input.board, input.prediction.basis.budgetId, row.stage.grantId);
    if (simulated.status !== "ready" || simulated.projection.status === "held") continue;

    const next = decideCentralLearning({ ...input, board: simulated.board, prediction: { ...input.prediction,
      basis: { ...input.prediction.basis, boardSequence: simulated.board.sequence } } }, predict);
    if (next.status !== "decided") return { status: "rejected", reason: `economic_reconcile_model:${next.reason}` };

    const option: CentralEconomicOption = { kind: "conditional_reconcile", grantId: row.stage.grantId,
      value: next.plan.netGain, modelRefs: [next.forecast.forecastRef, next.plan.modelHash] };

    options.push(option);
    choices.push({ option, step: { kind: "reconcile_then_replan", evaluation } });
  }

  const priority = { covered_prefix: 0, new_backlog: 1, conditional_reconcile: 2 } as const;
  const chosen = choices.filter(row => Number.isFinite(row.option.value) && row.option.value > 0)
    .sort((left, right) => right.option.value - left.option.value || priority[left.option.kind] - priority[right.option.kind])[0];

  return { status: "ready", nextStep: chosen?.step ?? idleStep(input, decision, originals), options };
}
