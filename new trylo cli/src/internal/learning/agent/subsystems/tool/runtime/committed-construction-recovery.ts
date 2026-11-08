import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { LearningJob } from "../../../../control/contracts.js";
import type { CentralLearningGrant } from "../../../../control/coordination-contract.js";
import { TOOL_CONSTRUCTION_NOT_STARTED } from "../domain/evolution/construction-stop.js";
import { toolLearningFundingClaimBelongsTo } from "../domain/evolution/funding-identity.js";
import { toolInternalRecipeVersionId } from "../domain/evolution/decision-identity.js";
import { decodeToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { resultVersionId, type ToolLearningPlan, type ToolLearningResult } from "../domain/evolution/pipeline.js";
import { frozenToolRecipeForResult } from "./frozen-recipe.js";
import { resultForJob } from "./pipeline-records.js";
import { assetAvailable, savePipelineAsset } from "./pipeline-assets.js";

/** Called only after the original lease expired or was yielded. The sole paid
 * request is its committed first planning decision. Funding reserves before
 * sending generation, so any second/unknown reservation requires inspection.
 * Recover only this local construction boundary; never replay a model call. */
export async function retainUnstartedToolConstruction(board: BoardStore, state: BoardState, input: {
  readonly job: LearningJob; readonly plan: ToolLearningPlan; readonly grant: CentralLearningGrant; readonly issuedAt: string;
}) {
  const { job, plan, grant } = input;
  const unchanged = () => ({ ok: true as const, result: undefined });

  if (job.state !== "running" || resultForJob(state, job.jobId, job.attempt) !== undefined) return unchanged();

  const reservations = grant.reservations.filter(row => toolLearningFundingClaimBelongsTo(plan, job.jobId, job.attempt, row.claimId));
  if (reservations.length !== 1 || reservations[0]?.state !== "settled" || reservations[0].usage?.kind !== "reported") return unchanged();

  const receipts = state.assets.filter(asset => asset.kind === "workflow" && asset.scope === plan.scope && recordOf(asset.content)
    && asset.content.type === "tool_learning_decision" && asset.content.jobId === job.jobId && asset.content.attempt === job.attempt);
  const receipt = receipts[0], raw = receipt?.content;
  if (receipts.length !== 1 || receipt === undefined || !assetAvailable(state, receipt) || !recordOf(raw)
    || raw.step !== 1 || raw.grantId !== grant.grantId) return unchanged();

  const decision = decodeToolLearningDecision(raw.decision);
  if (decision === undefined || (decision.action !== "create" && decision.action !== "improve")) return unchanged();

  if (state.assets.some(asset => asset.kind === "tool_package" && recordOf(asset.content) && recordOf(asset.content.request)
    && asset.content.request.requestId === `${job.jobId}:${job.attempt}`)) return unchanged();

  const result: ToolLearningResult = { type: "tool_learning_result", schemaVersion: 1, jobId: job.jobId, attempt: job.attempt,
    outcome: "waiting_evidence", code: TOOL_CONSTRUCTION_NOT_STARTED, occurredAt: input.issuedAt,
    search: resultForJob(state, job.jobId, job.attempt - 1)?.search ?? { status: "complete", candidates: [], failures: [] },
    decision, decisionVersionId: receipt.versionId, recipeVersionId: toolInternalRecipeVersionId(decision) };
  const frozen = frozenToolRecipeForResult(state, job, plan, result);
  if (!frozen.ok || frozen.selected === undefined) return unchanged();

  const saved = await savePipelineAsset(board, { versionId: resultVersionId(job.jobId, job.attempt), kind: "workflow", scope: plan.scope,
    source: "inferred", issuedAt: input.issuedAt, content: result,
    observations: [receipt.versionId, frozen.selected.versionId, reservations[0].reservationId] });

  return saved.ok ? { ok: true as const, result } : saved;
}
