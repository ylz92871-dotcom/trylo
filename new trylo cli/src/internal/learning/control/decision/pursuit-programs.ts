import { enumerateCentralTimingPrograms } from "./timing-model.js";
import type { CentralPursuitCandidate, CentralPursuitEvaluation, CentralPursuitInput } from "./pursuit-contract.js";
import type { CentralPursuitPlanningArm } from "./pursuit-planner.js";
import type { CentralTimingTarget } from "./timing-contract.js";

/** This objective awards exactly one credit on qualification and zero otherwise.
 * Its actual support is known without estimating completion-time probabilities. */
export function centralPursuitTimingTarget(candidate: CentralPursuitCandidate): CentralTimingTarget {
  return candidate.target?.kind === "deadline" && candidate.target.grossSupport === undefined
    ? { ...candidate.target, grossSupport: { minimum: 0, maximum: 1, sourceRef: candidate.objective.definitionRef } }
    : candidate.target;
}

/** Legal processing menus are kept even when their immediate expected value is
 * negative: their observation can improve choices for other actual objectives. */
export function centralPursuitPrograms(input: CentralPursuitInput, evaluations: readonly CentralPursuitEvaluation[],
  solved: ReadonlySet<string>): { readonly status: "ready"; readonly arms: readonly CentralPursuitPlanningArm[];
    readonly requirements: readonly string[] } | { readonly status: "rejected"; readonly reason: string } {
  const arms: CentralPursuitPlanningArm[] = [], requirements: string[] = [];

  for (const row of evaluations) {
    if ((row.stage.status !== "ready" && row.stage.status !== "continue_existing") || solved.has(row.candidate.objective.instanceId)) continue;

    const candidate = row.candidate;
    const menu = enumerateCentralTimingPrograms({ schemaVersion: 1, opportunityId: candidate.opportunity.opportunityId,
      windowRef: candidate.opportunity.windowRef, forecastRef: `pursuit:${row.prediction.model}`, mean: row.prediction.mean,
      basis: input.basis, offer: candidate.opportunity.offer, readiness: candidate.readiness, target: centralPursuitTimingTarget(candidate), fee: candidate.fee });
    if (menu.status !== "ready") return { status: "rejected", reason: menu.reason };

    requirements.push(...menu.requirements);
    const program = [...menu.programs].sort((left, right) => (right.grossMean - right.utilityFee)
      - (left.grossMean - left.utilityFee))[0];
    if (program === undefined) continue;

    if (program.grossMean !== 0 && program.grossMean !== row.prediction.mean) {
      return { status: "rejected", reason: "pursuit_completion_target_not_binary" };
    }

    arms.push({ evaluation: row, control: program.control, utilityFee: program.utilityFee,
      completionCredit: program.grossMean === 0 ? 0 : 1 });
  }

  return { status: "ready", arms, requirements };
}
