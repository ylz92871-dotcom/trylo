import type { BoardState } from "../../../../../control/state.js";
import type { LearningJob } from "../../../../../control/contracts.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { decodeToolLearningRecipe, type ToolLearningPlan, type ToolLearningResult, type ToolLearningRecipe } from "./pipeline.js";
import { decodeToolLearningDecision } from "./learning-plan.js";
import { toolInternalRecipeVersionId, toolLearningDecisionVersionId } from "./decision-identity.js";
import { hasFrozenToolConstruction } from "./construction-stop.js";
import { decodeToolEvolutionVerification, isDigest, isIsoTime, verificationBinds } from "./artifact.js";
import { keysAre, parseToolEvolutionCandidate, recordOf, textOf } from "./parse.js";
import { assetAvailable } from "./asset-availability.js";
import { toolLearningFundingIdentity, toolLearningFundingClaimBelongsTo } from "./funding-identity.js";

type PipelineFailure = { readonly ok: false; readonly code: string; readonly message: string };

type Selected = { readonly versionId: string; readonly recipe: ToolLearningRecipe };

/** Exact construction commitment, not a search for another same-capability oracle. */
export function frozenToolRecipeForResult(state: BoardState, job: Pick<LearningJob, "jobId" | "attempt">, plan: ToolLearningPlan,
  previous: ToolLearningResult | undefined): PipelineFailure | { readonly ok: true; readonly selected?: Selected } {
  if (!hasFrozenToolConstruction(previous)) {
    const reviewed = previous === undefined ? undefined : rejectedReturnedToolGeneration(state, job, plan, previous);
    return reviewed === undefined ? { ok: true } : { ok: true, selected: reviewed.selected };
  }
  return committedToolRecipeForResult(state, job, plan, previous);
}

/** Immutable receipt validation also serves local return recovery. It does not
 * declare a failed job resumable or authorize another provider request. */
export function committedToolRecipeForResult(state: BoardState, job: Pick<LearningJob, "jobId" | "attempt">, plan: ToolLearningPlan,
  previous: ToolLearningResult): PipelineFailure | { readonly ok: true; readonly selected?: Selected } {
  const asset = state.assets.find(row => row.versionId === previous.recipeVersionId);
  const recipe = asset === undefined ? undefined : decodeToolLearningRecipe(asset.content);
  const unavailable = (): PipelineFailure => ({ ok: false, code: "frozen_recipe_unavailable", message: "The exact committed construction recipe/decision is unavailable or differently bound; no oracle was replanned" });

  if (previous.jobId !== job.jobId || previous.attempt !== job.attempt || asset?.kind !== "verification_recipe" || !assetAvailable(state, asset)
    || asset.scope !== plan.scope || recipe === undefined || recipe.request.scope !== plan.scope || recipe.request.capability !== plan.capability) return unavailable();

  if (previous.decisionVersionId === undefined && previous.decision === undefined) {
    return asset.source === "user_explicit" && asset.versionId === `tool-recipe_v1_${contentHashOf(recipe)}`
      ? { ok: true, selected: { versionId: asset.versionId, recipe } } : unavailable();
  }

  const decision = state.assets.find(row => row.versionId === previous.decisionVersionId), raw = decision?.content;
  if (decision?.kind !== "workflow" || decision.scope !== plan.scope || decision.source !== "inferred" || !assetAvailable(state, decision)
    || !recordOf(raw) || !keysAre(raw, ["type", "schemaVersion", "jobId", "attempt", "contextHash", "decision", "grantId"], ["step", "selectedToolVersionId"])
    || raw.type !== "tool_learning_decision" || raw.schemaVersion !== 1 || raw.jobId !== job.jobId || typeof raw.attempt !== "number"
    || !Number.isSafeInteger(raw.attempt) || raw.attempt < 1 || raw.attempt > previous.attempt || !isDigest(raw.contextHash) || !textOf(raw.grantId, 256)
    || (raw.step !== undefined && (typeof raw.step !== "number" || !Number.isSafeInteger(raw.step) || raw.step < 1))) return unavailable();

  const decoded = decodeToolLearningDecision(raw.decision);
  if (decoded === undefined || !("request" in decoded) || previous.decision === undefined || contentHashOf(decoded) !== contentHashOf(previous.decision)
    || decision.versionId !== toolLearningDecisionVersionId({ jobId: job.jobId, attempt: raw.attempt, decision: decoded,
      ...(raw.step === undefined ? {} : { step: raw.step }) }) || asset.source !== "inferred" || asset.versionId !== toolInternalRecipeVersionId(decoded)
    || contentHashOf(recipe) !== contentHashOf({ type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn", request: decoded.request })) return unavailable();

  return { ok: true, selected: { versionId: asset.versionId, recipe } };
}

export const toolReturnReviewRef = (jobId: string, attempt: number) => `tool-return-review:${contentHashOf({ jobId, attempt })}`;

/** A transport-class failure alone never permits retry. A later complete,
 * measured return must fail the normal exact checks before explicit manual
 * construction may use its frozen recipe and actual rejection diagnostic. */
export function rejectedReturnedToolGeneration(state: BoardState, job: Pick<LearningJob, "jobId" | "attempt">,
  plan: ToolLearningPlan, result: ToolLearningResult) {
  if (result.outcome !== "failed" || result.code !== "provider_error" || result.cleanupCode !== undefined
    || result.candidateVersionId !== undefined || result.generation === undefined || result.generation.verification !== undefined) return undefined;

  const asset = state.assets.find(row => row.versionId === toolReturnReviewRef(job.jobId, job.attempt)), raw = asset?.content;
  if (asset?.kind !== "workflow" || asset.scope !== plan.scope || asset.source !== "inferred" || !assetAvailable(state, asset)
    || !recordOf(raw) || !keysAre(raw, ["type", "schemaVersion", "jobId", "attempt", "reservationId", "model", "responseText", "evidenceRef", "returnedAt",
      "sourceResultHash", "recipeVersionId", "requestHash", "verification"])
    || raw.type !== "tool_generation_return_rejection" || raw.schemaVersion !== 1 || raw.jobId !== job.jobId || raw.attempt !== job.attempt
    || typeof raw.responseText !== "string" || !textOf(raw.evidenceRef, 512) || !isIsoTime(raw.returnedAt)
    || raw.sourceResultHash !== contentHashOf(result)) return undefined;

  const identity = toolLearningFundingIdentity(plan), grant = state.centralLearningGrants?.find(row => row.grantId === identity.grantId);
  const reservation = grant?.reservations.find(row => row.reservationId === raw.reservationId);
  if (grant?.status !== "open" || grant.claim !== undefined && toolLearningFundingClaimBelongsTo(plan, job.jobId, job.attempt, grant.claim.claimId)
    || grant.reservations.some(row => row.state !== "settled")
    || reservation?.usage?.kind !== "reported" || reservation.usage.model !== raw.model
    || !toolLearningFundingClaimBelongsTo(plan, job.jobId, job.attempt, reservation.claimId)) return undefined;

  const frozen = committedToolRecipeForResult(state, job, plan, result);
  if (!frozen.ok || frozen.selected === undefined || raw.recipeVersionId !== frozen.selected.versionId) return undefined;

  const request = { ...frozen.selected.recipe.request, requestId: `${job.jobId}:${job.attempt}` };
  const candidate = parseToolEvolutionCandidate(raw.responseText, request.prior?.source), verification = decodeToolEvolutionVerification(raw.verification);
  if (!candidate.ok || raw.requestHash !== contentHashOf(request) || verification?.verdict !== "fail"
    || !verificationBinds(candidate.value, request, verification)
    || !verification.checks.some(check => check.outcome === "wrong_result" || check.outcome === "unexpected_error")
    || verification.checks.some(check => !["passed", "wrong_result", "unexpected_error"].includes(check.outcome))) return undefined;

  return { selected: frozen.selected, reviewRef: asset.versionId, verification,
    feedback: verification.checks.filter(check => check.outcome !== "passed").map(check => `${check.sampleId}: ${check.outcome}: ${check.detail}`).join("\n") };
}

