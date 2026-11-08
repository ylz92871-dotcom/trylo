import type { BoardState } from "../../../../../control/state.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { assetAvailable } from "./asset-availability.js";
import { toolConstructionNeedsEvidence, toolConstructionHostTimeout } from "./construction-stop.js";
import { frozenToolRecipeForResult, rejectedReturnedToolGeneration } from "./frozen-construction.js";
import { decodeToolLearningPlan, decodeToolLearningResult, planVersionId, resultVersionId, toolLearningJobId } from "./pipeline.js";
import { recordOf } from "./parse.js";
import { toolLearningFundingClaimBelongsTo, toolLearningFundingIdentity } from "./funding-identity.js";
import { decodeToolResearchStep } from "./research.js";
import { toolLearningDecisionVersionId } from "./decision-identity.js";
import { toolResearchReportsMatchRoot } from "./research-lineage.js";

export function isToolPlanningOutputRejection(code: string): boolean {
  return code === "tool_planning_incomplete_generation" || code === "tool_planning_invalid_json" || code === "invalid_learning_decision";
}

function originalSource(state: BoardState, jobId: string) {
  const job = state.jobs.find(item => item.jobId === jobId);
  if (job?.domain !== "tool") return undefined;

  const planAsset = state.assets.find(item => item.versionId === planVersionId(jobId));
  if (planAsset?.kind !== "workflow" || planAsset.scope !== job.scope || !assetAvailable(state, planAsset)) return undefined;

  const plan = decodeToolLearningPlan(planAsset.content);
  if (plan === undefined || plan.scope !== job.scope || plan.fundingOrigin !== undefined || toolLearningJobId(plan) !== jobId) return undefined;

  const identity = toolLearningFundingIdentity(plan), issue = state.learningIssues?.find(item => item.issueId === identity.issueId);
  const grant = state.centralLearningGrants?.find(item => item.grantId === identity.grantId);
  if (issue === undefined || !toolResearchReportsMatchRoot(state, issue.reports, plan)
    || grant?.issueId !== issue.issueId || grant.scope !== issue.scope || grant.domain !== "tool" || grant.budgetId === undefined) return undefined;

  return { job, plan, grant };
}

function originalCheckpoint(state: BoardState, jobId: string, resultRef: string) {
  const source = originalSource(state, jobId);
  if (source === undefined || !["waiting_evidence", "queued", "failed"].includes(source.job.state)
    || source.job.breakerOpen && !(source.job.state === "failed" && source.job.attempt >= source.job.maxAttempts)
    || resultRef !== resultVersionId(jobId, source.job.attempt)) return undefined;

  const resultAsset = state.assets.find(item => item.versionId === resultRef);
  if (resultAsset?.kind !== "workflow" || resultAsset.scope !== source.job.scope || !assetAvailable(state, resultAsset)) return undefined;

  const result = decodeToolLearningResult(resultAsset.content);
  if (result?.jobId !== jobId || result.attempt !== source.job.attempt
    || result.cleanupCode !== undefined || result.code === "allowance_release_failed") return undefined;

  return { ...source, result };
}

/** The original accounting owner confirms local completion before a result is
 * committed. A positive usage prefix or an active lease cannot supply this. */
export function isSettledToolPlanningAttempt(state: BoardState, jobId: string, attempt: number): boolean {
  const source = originalSource(state, jobId);
  if (source === undefined || source.job.attempt !== attempt || source.grant.status !== "open") return false;
  const owned = (claimId: string) => toolLearningFundingClaimBelongsTo(source.plan, jobId, attempt, claimId);
  const reservations = source.grant.reservations.filter(row => owned(row.claimId));
  return reservations.length > 0 && reservations.every(row => row.state === "settled" && row.usage?.kind === "reported")
    && (source.grant.claim === undefined || !owned(source.grant.claim.claimId));
}

/** A completed, tool-free planning request has no candidate side effects to
 * replay. Unknown bills and active old leases remain with their original owner. */
export function isKnownToolPlanningBoundary(state: BoardState, jobId: string, resultRef: string): boolean {
  const checkpoint = originalCheckpoint(state, jobId, resultRef);
  if (checkpoint === undefined) return false;

  const { job, result } = checkpoint;

  if (!["failed", "waiting_evidence"].includes(result.outcome)
    || result.candidateVersionId !== undefined || result.contractProposalId !== undefined || result.generation !== undefined) return false;

  if (!(isToolPlanningOutputRejection(result.code) && result.decision === undefined)
    && !originalLocalResearchCheckpoint(state, checkpoint)) return false;

  return isSettledToolPlanningAttempt(state, jobId, job.attempt);
}

/** Older workers hid a pre-request funding rejection as provider_error. A
 * committed local-library read and fully known bills establish real progress;
 * no remote search, construction, unknown call or old active lease qualifies. */
function originalLocalResearchCheckpoint(state: BoardState, checkpoint: NonNullable<ReturnType<typeof originalCheckpoint>>): boolean {
  const { job, result } = checkpoint, decision = result.decision;
  if (result.code !== "tool_planning_provider_error" || decision?.action !== "research" || !("libraryQuery" in decision)
    || !originalDecisionReceipt(state, checkpoint)) return false;

  return state.assets.some(asset => {
    if (asset.kind !== "workflow" || asset.scope !== job.scope || !assetAvailable(state, asset)) return false;
    const step = decodeToolResearchStep(asset.content);
    return step?.jobId === job.jobId && step.attempt === result.attempt && step.scope === job.scope
      && step.library !== undefined && step.request.kind === "library" && step.request.query === decision.libraryQuery
      && asset.versionId === `tool-research_v1_${contentHashOf({ jobId: job.jobId, step: step.step, request: step.request })}`;
  });
}

function originalDecisionReceipt(state: BoardState, checkpoint: NonNullable<ReturnType<typeof originalCheckpoint>>): boolean {
  const { job, result } = checkpoint;

  if (result.decision === undefined || result.decisionVersionId === undefined) return false;

  const archived = state.assets.find(item => item.versionId === result.decisionVersionId), raw = archived?.content;
  if (archived?.kind !== "workflow" || archived.scope !== job.scope || !assetAvailable(state, archived)
    || !recordOf(raw) || raw.type !== "tool_learning_decision" || raw.schemaVersion !== 1
    || raw.jobId !== job.jobId || raw.attempt !== result.attempt || raw.grantId !== checkpoint.grant.grantId
    || !(raw.step === undefined || typeof raw.step === "number" && Number.isSafeInteger(raw.step) && raw.step >= 1)) return false;

  return contentHashOf(raw.decision) === contentHashOf(result.decision)
    && archived.versionId === toolLearningDecisionVersionId({ jobId: job.jobId, attempt: result.attempt,
      decision: result.decision, ...(raw.step === undefined ? {} : { step: raw.step }) });
}

/** Domain-owned confirmation gate. A known tool-free planning boundary still
 * needs a fresh original managed stage/claim/CAS; no balance or authority is added. */
export function isManagedToolCheckpointContinuation(state: BoardState, jobId: string, resultRef: string): boolean {
  const checkpoint = originalCheckpoint(state, jobId, resultRef);
  if (checkpoint === undefined) return false;

  if (isKnownToolPlanningBoundary(state, jobId, resultRef)) return true;

  const { job, result } = checkpoint;

  if (rejectedReturnedToolGeneration(state, job, checkpoint.plan, result) !== undefined) return true;

  if (result.outcome === "failed" && toolConstructionHostTimeout(result.code) && result.generation !== undefined
    && result.generation.verification === undefined && result.candidateVersionId === undefined && result.contractProposalId === undefined) {
    const owned = (claimId: string) => toolLearningFundingClaimBelongsTo(checkpoint.plan, jobId, job.attempt, claimId);
    const reservations = checkpoint.grant.reservations.filter(row => owned(row.claimId));
    const frozen = frozenToolRecipeForResult(state, job, checkpoint.plan, result);

    // A confirmed stopped, tool-free generation may be explicitly continued.
    // Unknown usage remains charged at its original reservation; no refund or
    // automatic retry is authorized by this checkpoint proof.
    return reservations.length > 0 && reservations.every(row => row.state === "settled")
      && !checkpoint.grant.reservations.some(row => row.state === "reserved")
      && (checkpoint.grant.claim === undefined || !owned(checkpoint.grant.claim.claimId))
      && frozen.ok && frozen.selected !== undefined;
  }

  if (job.breakerOpen || job.state === "failed" || result.outcome !== "waiting_evidence") return false;

  if (toolConstructionNeedsEvidence(result.code) || ["verification_recipe_required", "manual_recipe", "research_capacity"].includes(result.code)) return true;

  // A returned strategy is a confirmed local checkpoint. Re-read its immutable
  // decision receipt, rather than treating arbitrary adaptation failures as one.
  const decision = result.decision;
  if (decision === undefined || result.decisionVersionId === undefined
    || !(decision.action === "defer" && decision.reason === result.code
      || decision.action === "refine" && result.code === "usage_revision_proposed"
      || decision.action === "revise_contract" && result.code === "contract_revision_approval_required")) return false;

  return originalDecisionReceipt(state, checkpoint);
}
