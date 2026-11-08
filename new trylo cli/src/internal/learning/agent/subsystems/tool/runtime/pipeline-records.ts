import type { BoardState } from "../../../../control/state.js";
import { decodeToolLearningRecipe, decodeToolLearningResult, resultVersionId, validToolPipelineJobs,
  type ToolLearningPlan, type ToolLearningResult } from "../domain/evolution/pipeline.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import { assetAvailable } from "./pipeline-assets.js";
import { toolLearningPlanFromBoard } from "../domain/evolution/research-lineage.js";

/** Shared pure archive readers; planning context must not import the queue's IO owner. */
export function planForJob(state: BoardState, jobId: string) {
  if (!validToolPipelineJobs(state)) return undefined;
  return toolLearningPlanFromBoard(state, jobId);
}

export function resultForJob(state: BoardState, jobId: string, attempt: number) {
  const asset = state.assets.find(item => item.versionId === resultVersionId(jobId, attempt));
  if (asset === undefined || asset.kind !== "workflow" || !assetAvailable(state, asset)) return undefined;
  const result = decodeToolLearningResult(asset.content), plan = planForJob(state, jobId);
  return plan !== undefined && result?.jobId === jobId && result.attempt === attempt && asset.scope === plan.scope ? result : undefined;
}

/** Shared by actual publication admission and historical producer proof. */
export function candidateBindsToolLearningRecipe(request: ToolEvolutionRequest, raw: unknown, plan: ToolLearningPlan, result: ToolLearningResult): boolean {
  const recipe = decodeToolLearningRecipe(raw);
  return recipe !== undefined && request.requestId === `${result.jobId}:${result.attempt}` && request.scope === plan.scope
    && request.capability === plan.capability && contentHashOf(request) === contentHashOf({ ...recipe.request, requestId: request.requestId });
}
