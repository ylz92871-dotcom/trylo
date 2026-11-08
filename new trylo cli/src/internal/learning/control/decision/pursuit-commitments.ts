import { isAllocationResources } from "../allocation-shape.js";
import { planSequentialAllocation } from "../sequential-allocation.js";
import type { LearningAllocationResources } from "../allocation-contract.js";
import type { SequentialAllocationPlan } from "../sequential-allocation-contract.js";
import type { CentralPursuitEvaluation, CentralPursuitInput, CentralPursuitResult } from "./pursuit-contract.js";
import { compileCentralPursuitPlan } from "./pursuit-planner.js";
import type { CentralPursuitPlanningArm } from "./pursuit-planner.js";
import { centralPursuitFamilyKey } from "./pursuit-prediction.js";
import { projectCentralDecisionStage } from "./stage-projection.js";
import { centralPursuitPrograms } from "./pursuit-programs.js";
import { simulateCentralReconcile } from "./reconcile-option.js";
import { centralPursuitTreatmentRef } from "./pursuit-resource-model.js";

type Option = Extract<CentralPursuitResult, { status: "decided" }>["options"][number];

type PlanResult = { readonly status: "ready"; readonly plan: SequentialAllocationPlan; readonly proposalJson: string }
  | { readonly status: "rejected"; readonly reason: string };

export function planCentralPursuitBacklog(input: CentralPursuitInput, arms: readonly CentralPursuitPlanningArm[],
  remaining: LearningAllocationResources, horizon = input.horizon,
  beliefUpdates?: Parameters<typeof compileCentralPursuitPlan>[0]["beliefUpdates"]): PlanResult {
  const compiled = compileCentralPursuitPlan({ basis: input.basis, remaining, horizon, arms,
    ...(beliefUpdates === undefined ? {} : { beliefUpdates }) });
  if (compiled.status !== "ready") return { status: "rejected", reason: compiled.reason };
  const proposalJson = JSON.stringify(compiled.request), planned = planSequentialAllocation(proposalJson);
  return planned.status === "planned" ? { status: "ready", plan: planned.plan, proposalJson }
    : { status: "rejected", reason: planned.reason };
}

/** Covered stages are not inserted as zero-resource provider offers. Their known
 * grant covers this prefix; every subsequent new stage still uses actual free
 * root money. Release is a separate conditional action, never an assumed refund. */
export function centralPursuitCommitmentOptions(input: CentralPursuitInput, evaluations: readonly CentralPursuitEvaluation[],
  allArms: readonly CentralPursuitPlanningArm[], remaining: LearningAllocationResources, solved: ReadonlySet<string>):
  { readonly status: "ready"; readonly options: readonly { readonly option: Option;
    readonly evaluation: CentralPursuitEvaluation; readonly control: "now" | "defer" }[] }
  | { readonly status: "rejected"; readonly reason: string } {
  const options: { option: Option; evaluation: CentralPursuitEvaluation; control: "now" | "defer" }[] = [];
  const fresh = allArms.filter(arm => arm.evaluation.stage.status === "ready");

  for (const arm of allArms.filter(row => row.evaluation.stage.status === "continue_existing")) {
    const row = arm.evaluation;
    const following = fresh.filter(item => item.evaluation.candidate.objective.instanceId !== row.candidate.objective.instanceId);
    const familyKey = centralPursuitFamilyKey(input.basis.scope, row.candidate.objective, row.candidate.opportunity.conditionRef);
    const treatmentRef = centralPursuitTreatmentRef(row.candidate.opportunity.offer);
    const success = planCentralPursuitBacklog(input, following, remaining, input.horizon - 1,
      [{ familyKey, treatmentRef, qualified: 1, noResult: 0 }]);
    const failure = planCentralPursuitBacklog(input, following, remaining, input.horizon - 1,
      [{ familyKey, treatmentRef, qualified: 0, noResult: 1 }]);

    if (success.status !== "ready") return success;

    if (failure.status !== "ready") return failure;

    const probability = row.prediction.mean;
    const value = probability * (arm.completionCredit + success.plan.netPolicyValue)
      + (1 - probability) * failure.plan.netPolicyValue - arm.utilityFee;

    options.push({ option: { kind: "covered_prefix", grantId: row.stage.grantId, value,
      modelRefs: [success.plan.modelHash, failure.plan.modelHash] }, evaluation: row, control: arm.control });
  }

  const examined = new Set<string>();

  for (const row of evaluations) {
    if ((row.stage.status !== "continue_existing" && row.stage.status !== "reconcile_then_replan") || examined.has(row.stage.grantId)) continue;

    examined.add(row.stage.grantId);
    const released = simulateCentralReconcile(input.board, input.basis.budgetId, row.stage.grantId);
    if (released.status !== "ready" || released.projection.status === "held") continue;

    const remainingAfterRelease = { ...released.projection.available, calls: Math.min(1024, released.projection.available.calls),
      steps: Math.min(1024, released.projection.available.steps) };
    if (!isAllocationResources(remainingAfterRelease)) continue;

    const afterRelease = evaluations.map(evaluation => ({ ...evaluation, stage: projectCentralDecisionStage({
      ...evaluation.candidate.source, board: released.board, scope: input.basis.scope, budgetId: input.basis.budgetId,
      offer: evaluation.candidate.opportunity.offer }) }));
    const menu = centralPursuitPrograms(input, afterRelease, solved);
    if (menu.status !== "ready") return menu;

    const planned = planCentralPursuitBacklog(input, menu.arms.filter(item => item.evaluation.stage.status === "ready"), remainingAfterRelease);
    if (planned.status !== "ready") return planned;

    options.push({ option: { kind: "conditional_reconcile", grantId: row.stage.grantId, value: planned.plan.netPolicyValue,
      modelRefs: [planned.plan.modelHash] }, evaluation: row, control: "now" });
  }

  return { status: "ready", options };
}
