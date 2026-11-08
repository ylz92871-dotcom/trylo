import { contentHashOf } from "../../../../../control/hash.js";
import type { ToolLearningDecision } from "./learning-plan.js";

/** A missing step is the original persisted identity; explicit steps belong to the research loop. */
export function toolLearningDecisionVersionId(input: { readonly jobId: string; readonly attempt: number;
  readonly decision: ToolLearningDecision; readonly step?: number }): string {
  return `tool-decision_v1_${contentHashOf({ jobId: input.jobId, attempt: input.attempt,
    ...(input.step === undefined ? {} : { step: input.step }), decision: input.decision })}`;
}

export function toolInternalRecipeVersionId(decision: ToolLearningDecision): string {
  return `tool-internal-recipe_v1_${contentHashOf(decision)}`;
}
