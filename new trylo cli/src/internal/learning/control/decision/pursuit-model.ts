import { allocationFits, isAllocationResources } from "../allocation-shape.js";
import { centralBudgetProjection } from "../central-budget-state.js";
import { contentHashOf } from "../hash.js";
import { projectCentralDecisionStage } from "./stage-projection.js";
import { analyzeCentralOpportunityTiming } from "./timing-model.js";
import { predictCentralPursuitCandidates } from "./pursuit-prediction.js";
import { validCentralPursuitInput } from "./pursuit-input.js";
import { centralPursuitPrograms, centralPursuitTimingTarget } from "./pursuit-programs.js";
import { centralPursuitCommitmentOptions, planCentralPursuitBacklog } from "./pursuit-commitments.js";
import type { CentralPursuitEvaluation, CentralPursuitInput, CentralPursuitNextStep, CentralPursuitResult } from "./pursuit-contract.js";

const replanOn = ["effective_objective_outcome_revision", "actual_source_stage_boundary", "policy_or_objective_revision",
  "confirmed_usage_and_budget_reconcile", "business_calendar_or_readiness_change"] as const;

function idleStep(evaluations: readonly CentralPursuitEvaluation[], requirements: readonly string[]): CentralPursuitNextStep {
  const reconcile = evaluations.find(row => row.stage.status === "reconcile_then_replan");
  if (reconcile !== undefined) return { kind: "reconcile_then_replan", evaluation: reconcile };

  const covered = evaluations.find(row => row.stage.status === "continue_existing");
  if (covered !== undefined && requirements.length === 0) return { kind: "end_investment", evaluation: covered,
    reason: "declared_objective_has_no_positive_known_continuation" };

  const waiting = evaluations.filter(row => row.stage.status !== "terminal" && row.stage.status !== "ready");
  if (waiting.length > 0 || requirements.length > 0) return { kind: "wait", reasons: [...new Set([
    ...waiting.map(row => row.stage.status), ...requirements])], sourceRefs: [...new Set(waiting.flatMap(row => row.stage.sourceRefs))] };

  return { kind: "stop" };
}

/** A normal cold-start entry. The reference prior supplies a declared prediction,
 * actual observations update it, the timing family supplies feasible programs,
 * and the original finite allocator chooses the first physical investment from
 * a nonanticipative posterior-feedback graph over the real available backlog. */
export function decideCentralLearningPursuit(input: CentralPursuitInput): CentralPursuitResult {
  if (!validCentralPursuitInput(input)) return { status: "rejected", reason: "central_pursuit_input" };

  const predicted = predictCentralPursuitCandidates(input.candidates, input.observations, input.basis);
  if (predicted.status !== "ready") return { status: "rejected", reason: predicted.reason };

  const first = input.candidates[0]?.objective;
  if (first !== undefined && input.candidates.some(row => row.objective.criterion !== first.criterion
    || row.objective.definitionRef !== first.definitionRef)) return { status: "rejected", reason: "pursuit_incomparable_objectives" };

  const budget = centralBudgetProjection(input.board, input.basis.budgetId);
  if (budget === undefined || budget.budget.scope !== input.basis.scope || budget.status === "held") {
    return { status: "rejected", reason: "pursuit_budget_unavailable" };
  }

  const remaining = { tokens: budget.available.tokens, calls: Math.min(1024, budget.available.calls), steps: Math.min(1024, budget.available.steps) };
  if (!isAllocationResources(remaining)) return { status: "rejected", reason: "pursuit_budget_shape" };

  const evaluations: CentralPursuitEvaluation[] = input.candidates.map((candidate, index) => {
    const prediction = predicted.predictions[index]!;
    const stage = projectCentralDecisionStage({ ...candidate.source, board: input.board, scope: input.basis.scope,
      budgetId: input.basis.budgetId, offer: candidate.opportunity.offer });
    const timing = analyzeCentralOpportunityTiming({ schemaVersion: 1, opportunityId: candidate.opportunity.opportunityId,
      windowRef: candidate.opportunity.windowRef, forecastRef: predicted.modelRef, mean: prediction.mean,
      basis: input.basis, offer: candidate.opportunity.offer, readiness: candidate.readiness, target: centralPursuitTimingTarget(candidate), fee: candidate.fee });

    return { candidate, prediction, stage, timing };
  });
  const timingFailure = evaluations.find(row => row.timing?.status === "rejected");
  if (timingFailure?.timing?.status === "rejected") return { status: "rejected", reason: timingFailure.timing.reason };

  const solved = new Set(input.observations.filter(row => row.outcome === "qualified").map(row => row.objective.instanceId));
  const objective = first === undefined ? null : { criterion: first.criterion, definitionRef: first.definitionRef,
    unit: "qualified_objective_completions" as const };
  const base = { status: "decided" as const, decisionRef: `central-pursuit:${contentHashOf({ input, evaluations })}`,
    basis: input.basis, objective, remaining, evaluations, replanOn,
    assumptions: [...predicted.assumptions, "Only real described stages and unique objective instances occur in the planning backlog",
      "Source order defines a canonical queue for offers with the same owner and physical cap",
      "Future planning conservatively charges the full stage reserve, never an unconfirmed refund",
      "The planning context holds declared readiness and fees fixed until real reobservation",
      "The option menu is a new-stage backlog policy, one covered prefix with a new-stage continuation, or one conditional canonical release"] };
  const menu = centralPursuitPrograms(input, evaluations, solved);
  if (menu.status !== "ready") return menu;

  const freshArms = menu.arms.filter(arm => arm.evaluation.stage.status === "ready");
  const planned = planCentralPursuitBacklog(input, freshArms, remaining);
  if (planned.status !== "ready") return planned;

  const committed = centralPursuitCommitmentOptions(input, evaluations, menu.arms, remaining, solved);
  if (committed.status !== "ready") return committed;

  const options = [{ kind: "new_backlog" as const, grantId: null, value: planned.plan.netPolicyValue,
    modelRefs: [planned.plan.modelHash] }, ...committed.options.map(row => row.option)];
  const alternative = [...committed.options].sort((left, right) => right.option.value - left.option.value)[0];
  if (alternative !== undefined && alternative.option.value > 0 && alternative.option.value >= planned.plan.netPolicyValue) {
    const nextStep: CentralPursuitNextStep = alternative.option.kind === "conditional_reconcile"
      ? { kind: "reconcile_then_replan", evaluation: alternative.evaluation }
      : alternative.control === "defer" ? { kind: "defer", evaluation: alternative.evaluation }
        : { kind: "dispatch_existing", evaluation: alternative.evaluation, application: null };
    return { ...base, plan: null, options, nextStep };
  }

  const selected = planned.plan.decision;
  let nextStep: CentralPursuitNextStep;

  if (selected.kind === "stop") {
    const resourceRequirements = freshArms.some(arm => !allocationFits(arm.evaluation.candidate.opportunity.offer.reserve, remaining))
      ? ["current_resources_insufficient"] : [];
    nextStep = idleStep(evaluations, [...menu.requirements, ...resourceRequirements]);
  } else {
    const arm = freshArms.find(item => item.evaluation.candidate.opportunity.offer.offerId === selected.offer.offerId)!;
    nextStep = arm.control === "now" ? { kind: "fund_and_dispatch", evaluation: arm.evaluation,
      application: { kind: "sequential", proposalJson: planned.proposalJson } } : { kind: "defer", evaluation: arm.evaluation };
  }

  return { ...base, plan: planned.plan, options, nextStep };
}
