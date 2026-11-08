import type { LearningAllocationBasis, LearningAllocationResources } from "../allocation-contract.js";
import { allocationCapKey, allocationFits } from "../allocation-shape.js";
import { contentHashOf } from "../hash.js";
import { SEQUENTIAL_ALLOCATION_LIMITS } from "../sequential-allocation-contract.js";
import type { SequentialAllocationRequest, SequentialAllocationState } from "../sequential-allocation-contract.js";
import type { CentralPursuitEvaluation } from "./pursuit-contract.js";
import { centralPursuitConditionalProbability, centralPursuitFamilyKey } from "./pursuit-prediction.js";
import { centralPursuitTreatmentRef } from "./pursuit-resource-model.js";

export type CentralPursuitPlanningArm = {
  readonly evaluation: CentralPursuitEvaluation;
  readonly control: "now" | "defer";
  readonly utilityFee: number;
  /** One objective credit if it is completed in the declared use window, otherwise zero. */
  readonly completionCredit: 0 | 1;
};

type CompilerResult = { readonly status: "ready"; readonly request: SequentialAllocationRequest;
  readonly arms: readonly CentralPursuitPlanningArm[] }
  | { readonly status: "unsupported"; readonly reason: string };

/** Compiles only the real source-described backlog. A trial is a bounded macro-stage,
 * not a fictitious repetition of a provider call. Each stage can be attempted once;
 * each objective instance earns credit once even when it has several depth offers. */
export function compileCentralPursuitPlan(input: {
  readonly basis: LearningAllocationBasis;
  readonly remaining: LearningAllocationResources;
  readonly horizon: number;
  readonly arms: readonly CentralPursuitPlanningArm[];
  /** Conditional planning observations, separate from all persisted source facts. */
  readonly beliefUpdates?: readonly { readonly familyKey: string; readonly treatmentRef: string;
    readonly qualified: number; readonly noResult: number }[];
}): CompilerResult {
  const { arms } = input;

  if (arms.length > 30) return { status: "unsupported", reason: "pursuit_candidate_capacity" };

  if (input.horizon > 1 && arms.some(arm => arm.evaluation.candidate.target.kind !== "boundary-independent")) {
    return { status: "unsupported", reason: "pursuit_future_calendar_not_declared" };
  }

  const familyKeys = arms.map(arm => centralPursuitFamilyKey(input.basis.scope, arm.evaluation.candidate.objective,
    arm.evaluation.candidate.opportunity.conditionRef));
  const objectives = [...new Set(arms.map(arm => arm.evaluation.candidate.objective.instanceId))];
  const objectiveBits = arms.map(arm => 2 ** objectives.indexOf(arm.evaluation.candidate.objective.instanceId));
  const states = new Map<string, SequentialAllocationState>();
  let offerCount = 0, branchCount = 0, failure: string | undefined;

  function visit(attempted: number, successfulAttempts: number, attemptedObjectives: number, completed: number, depth: number,
    remaining: LearningAllocationResources): string {
    const key = `${attempted}:${successfulAttempts}`, stateId = `pursuit:${key}`;
    if (states.has(key) || failure !== undefined) return stateId;

    if (states.size >= SEQUENTIAL_ALLOCATION_LIMITS.states) {
      failure = "pursuit_state_capacity";
      return stateId;
    }

    const offers: SequentialAllocationState["offers"][number][] = [];

    states.set(key, { stateId, stopValue: completed, offers });

    if (depth >= input.horizon) return stateId;

    // Source order is a canonical domain queue at each identical owner/cap. The
    // allocator does not exploit opaque IDs to select private domain assets.
    const ownerCaps = new Set<string>();

    for (const [index, arm] of arms.entries()) {
      const bit = 2 ** index, { candidate, prediction } = arm.evaluation;
      if ((attempted & bit) !== 0 || (attemptedObjectives & objectiveBits[index]!) !== 0
        || !allocationFits(candidate.opportunity.offer.reserve, remaining)) continue;

      const cap = allocationCapKey(candidate.opportunity.offer);
      if (ownerCaps.has(cap)) continue;

      ownerCaps.add(cap);
      const observations: { treatmentRef: string; outcome: 0 | 1 }[] = [];

      for (const update of input.beliefUpdates ?? []) {
        if (update.familyKey !== familyKeys[index]) continue;
        for (let count = 0; count < update.qualified; count++) observations.push({ treatmentRef: update.treatmentRef, outcome: 1 });
        for (let count = 0; count < update.noResult; count++) observations.push({ treatmentRef: update.treatmentRef, outcome: 0 });
      }

      for (let previous = 0; previous < arms.length; previous++) {
        if ((attempted & 2 ** previous) === 0 || familyKeys[previous] !== familyKeys[index]) continue;
        observations.push({ treatmentRef: centralPursuitTreatmentRef(arms[previous]!.evaluation.candidate.opportunity.offer),
          outcome: (successfulAttempts & 2 ** previous) !== 0 ? 1 : 0 });
      }

      const predicted = centralPursuitConditionalProbability(prediction, observations);
      if (predicted.status !== "ready") {
        failure = predicted.reason;
        break;
      }

      const probability = predicted.mean, charge = candidate.opportunity.offer.reserve;
      const afterCharge = { tokens: remaining.tokens - charge.tokens, calls: remaining.calls - charge.calls,
        steps: remaining.steps - charge.steps };
      const successId = visit(attempted | bit, successfulAttempts | bit, attemptedObjectives | objectiveBits[index]!, completed + arm.completionCredit,
        depth + 1, afterCharge);
      const failureId = visit(attempted | bit, successfulAttempts, attemptedObjectives | objectiveBits[index]!, completed, depth + 1, afterCharge);

      if (failure !== undefined) break;

      offerCount += 1;
      branchCount += 2;

      if (offerCount > SEQUENTIAL_ALLOCATION_LIMITS.offers || branchCount > SEQUENTIAL_ALLOCATION_LIMITS.branches) {
        failure = "pursuit_offer_capacity";
        break;
      }

      offers.push({ offer: candidate.opportunity.offer, outcomes: [
        { probability, cost: charge, utilityCost: arm.utilityFee, nextStateId: successId },
        { probability: 1 - probability, cost: charge, utilityCost: arm.utilityFee, nextStateId: failureId },
      ] });
    }

    return stateId;
  }

  const initialStateId = visit(0, 0, 0, 0, 0, input.remaining);

  if (failure !== undefined) return { status: "unsupported", reason: failure };

  const request: SequentialAllocationRequest = { schemaVersion: 1, modelKind: "declared_finite_observable",
    basis: { ...input.basis, valuationRef: `pursuit-model:${contentHashOf(input)}` }, initialStateId,
    remaining: input.remaining, horizon: input.horizon, states: [...states.values()] };
  if (JSON.stringify(request).length > SEQUENTIAL_ALLOCATION_LIMITS.jsonCharacters) {
    return { status: "unsupported", reason: "pursuit_model_capacity" };
  }

  return { status: "ready", request, arms };
}
