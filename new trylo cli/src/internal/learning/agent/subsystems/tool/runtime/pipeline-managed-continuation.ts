import type { ManagedJobContinuation } from "../../../../control/commands.js";
import type { LearningJob } from "../../../../control/contracts.js";
import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { isCentralLearningAllowance } from "../../../../control/coordination-parse.js";
import { allocationFits } from "../../../../control/allocation-shape.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { resultVersionId } from "../domain/evolution/pipeline.js";
import { toolLearningFundingClaimId, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { isManagedToolCheckpointContinuation } from "../domain/evolution/managed-continuation.js";
import { managedSourceFailure, type ManagedToolFundingBinding } from "./learning-funding.js";
import { selectToolFocusedSource } from "./central-source.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** One original writer acquires the budget lease before asking the native
 * start/requeue owner to consume its exact confirmed-checkpoint proof. */
export async function claimManagedToolContinuation(board: BoardStore, state: BoardState, plan: ToolLearningPlan,
  job: LearningJob, binding: ManagedToolFundingBinding | undefined, now: number) {
  if (job.attempt < job.maxAttempts && job.state !== "failed") return { ok: true as const };

  const resultRef = resultVersionId(job.jobId, job.attempt);
  if (binding === undefined || !isManagedToolCheckpointContinuation(state, job.jobId, resultRef)) {
    return pipelineFailure("job_budget_exceeded", "Only a confirmed original managed checkpoint can continue past the legacy attempt cap");
  }

  const grant = state.centralLearningGrants?.find(item => item.grantId === binding.grantId);
  const issue = state.learningIssues?.find(item => item.issueId === binding.issueId);
  const source = selectToolFocusedSource(state, issue, plan.scope, grant?.scope ?? "");
  const stage = binding.stage, budgetJob = state.jobs.find(item => item.jobId === grant?.jobId);
  if (grant === undefined || grant.budgetId !== binding.budgetId || grant.status !== "open" || grant.claim !== undefined
    || !source.ok || source.jobId !== job.jobId || source.grantId !== grant.grantId || !toolFundingGrantMatches(state, plan, grant)
    || issue?.decision.kind !== "focused_learning" || issue.revision !== binding.expectedIssueRevision
    || issue.decision.revision !== grant.focusRevision || budgetJob?.state !== "queued"
    || stage === undefined || !isCentralLearningAllowance(stage.allowance) || stage.chargedAtStart.calls !== grant.reservations.length
    || stage.chargedAtStart.steps !== grant.reservations.length || !allocationFits({ tokens: stage.allowance.maxTokens,
      calls: stage.allowance.maxCalls, steps: stage.allowance.maxSteps }, centralLearningRemaining(grant))) {
    return pipelineFailure("tool_managed_stage_binding", "The exact original grant, source and committed operation must remain available");
  }

  const sourceFailure = managedSourceFailure(state, plan, binding);
  if (sourceFailure !== undefined) return sourceFailure;

  const claimId = toolLearningFundingClaimId(plan, job.jobId, job.attempt + 1, budgetJob.attempt + 1);
  const action = { kind: "claim" as const, jobId: budgetJob.jobId, expectedAttempt: budgetJob.attempt, claimId,
    ownerId: toolLearningFundingIdentity(plan).ownerId, expiresAt: new Date(now + 600000).toISOString(), expectedIssueRevision: issue.revision };
  const claimed = await board.apply({ type: "coordinate_learning", commandId: `tool-managed-start:${contentHashOf(action)}`,
    issuedAt: new Date(now).toISOString(), action });
  if (!claimed.ok) return pipelineFailure(claimed.reason, claimed.detail);

  const continuation: ManagedJobContinuation = { grantId: grant.grantId, claimId, expectedIssueRevision: issue.revision,
    resultRef, expectedAttempt: job.attempt };

  return { ok: true as const, continuation };
}

/** Compensate only a lease which provably sent zero requests. Paid/unknown work
 * remains with its original funding/recovery owner. Caller already holds writer. */
export async function yieldUnspentToolContinuation(board: BoardStore, continuation: ManagedJobContinuation, now: number) {
  const current = await board.load();
  if (!current.ok) return pipelineFailure(current.reason, current.detail);

  const grant = current.state.centralLearningGrants?.find(item => item.grantId === continuation.grantId);
  if (grant?.claim?.claimId !== continuation.claimId) return { ok: true as const };

  if (grant.reservations.some(item => item.claimId === continuation.claimId)) return { ok: true as const };

  const yielded = await board.apply({ type: "coordinate_learning", commandId: `tool-managed-unspent:${contentHashOf(continuation)}`,
    issuedAt: new Date(now).toISOString(), action: { kind: "finish", jobId: grant.jobId, claimId: continuation.claimId,
      expectedIssueRevision: continuation.expectedIssueRevision, result: { kind: "yielded", reason: "tool_managed_unspent_boundary" } } });

  return yielded.ok ? { ok: true as const } : pipelineFailure(yielded.reason, yielded.detail);
}
