import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningFundingClaimId, toolLearningFundingClaimMatches, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { isManagedToolCheckpointContinuation } from "../domain/evolution/managed-continuation.js";
import { resultVersionId } from "../domain/evolution/pipeline.js";
import { selectToolFocusedSource } from "./central-source.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";
import { yieldUnspentToolContinuation } from "./pipeline-managed-continuation.js";

type Options = { readonly boardRoot: string; readonly scope: string; readonly centralScope: string; readonly now: () => number };

/** New start-proof crash boundary only. A live lease stays busy; an expired
 * future-attempt lease with zero requests can yield without replaying any work.
 * Existing running/paid recovery remains with the frozen original owner. */
export async function recoverManagedToolPrestart(options: Options, signal: AbortSignal, issueId?: string) {
  if (signal.aborted) return { ok: false as const, reason: "learning_aborted" };

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return loaded;

  const ids = (loaded.state.learningIssues ?? []).filter(issue => issue.scope === options.centralScope
    && (issueId === undefined || issue.issueId === issueId) && issue.reports.length > 0
    && issue.reports.every(report => "subsystem" in report.source && report.source.subsystem === "tool")).map(issue => issue.issueId);

  for (const selected of ids) {
    const result = await withBoardWriter(options.boardRoot, async board => {
      const current = await board.load();
      if (!current.ok) return current;

      const issue = current.state.learningIssues?.find(item => item.issueId === selected);
      if (issue?.decision.kind !== "focused_learning") return { ok: true as const };

      const source = selectToolFocusedSource(current.state, issue, options.scope, options.centralScope);
      if (!source.ok) return { ok: false as const, reason: source.code };

      const { job, plan } = source, grant = current.state.centralLearningGrants?.find(item => item.grantId === source.grantId);
      if (grant?.budgetId === undefined || grant.status !== "open" || grant.claim === undefined
        || job.attempt < job.maxAttempts || !["queued", "waiting_evidence"].includes(job.state)
        || !toolLearningFundingClaimMatches(plan, job.jobId, job.attempt + 1, grant.claim)
        || grant.reservations.some(item => item.claimId === grant.claim!.claimId)
        || Date.parse(grant.claim.expiresAt) > options.now()) return { ok: true as const };

      const budgetJob = current.state.jobs.find(item => item.jobId === grant.jobId);
      if (!toolFundingGrantMatches(current.state, plan, grant) || issue.grantId !== grant.grantId || issue.jobId !== grant.jobId
        || grant.focusRevision !== issue.decision.revision || budgetJob?.state !== "running"
        || !isManagedToolCheckpointContinuation(current.state, job.jobId, resultVersionId(job.jobId, job.attempt))) {
        return { ok: false as const, reason: "tool_managed_prestart_binding" };
      }

      const claimId = toolLearningFundingClaimId(plan, job.jobId, job.attempt + 1, budgetJob.attempt + 1);
      const action = { kind: "claim" as const, jobId: budgetJob.jobId, expectedAttempt: budgetJob.attempt, claimId,
        ownerId: toolLearningFundingIdentity(plan).ownerId, expiresAt: new Date(options.now() + 120000).toISOString(), expectedIssueRevision: issue.revision };
      const claimed = await board.apply({ type: "coordinate_learning", commandId: `tool-prestart-recovery:${contentHashOf(action)}`,
        issuedAt: new Date(options.now()).toISOString(), action });
      if (!claimed.ok) return { ok: false as const, reason: claimed.reason };

      return yieldUnspentToolContinuation(board, { grantId: grant.grantId, claimId, expectedIssueRevision: issue.revision,
        resultRef: resultVersionId(job.jobId, job.attempt), expectedAttempt: job.attempt }, options.now());
    });
    if (!result.ok) return { ok: false as const, reason: "reason" in result ? result.reason : result.code };
  }

  return { ok: true as const };
}
