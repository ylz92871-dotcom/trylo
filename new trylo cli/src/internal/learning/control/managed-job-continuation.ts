import type { ManagedJobContinuation } from "./commands.js";
import type { LearningJob } from "./contracts.js";
import type { BoardState } from "./state.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isManagedToolCheckpointContinuation } from "../agent/subsystems/tool/domain/evolution/managed-continuation.js";

function attestation(value: unknown): value is ManagedJobContinuation {
  return fields(value, ["grantId", "claimId", "expectedIssueRevision", "resultRef", "expectedAttempt"])
    && [value.grantId, value.claimId, value.resultRef].every(identity)
    && sequence(value.expectedIssueRevision) && sequence(value.expectedAttempt);
}

/** Shared authority proof; the original tool domain alone qualifies its private checkpoint.
 * Only the domain's confirmed checkpoint may continue; no new balance is created. */
export function allowsManagedJobContinuation(state: BoardState, job: LearningJob, issuedAt: string, value: unknown): boolean {
  if (!attestation(value) || job.domain !== "tool" || job.coordination !== undefined
    || value.expectedAttempt !== job.attempt || !["waiting_evidence", "queued", "failed"].includes(job.state)) return false;

  const grant = state.centralLearningGrants?.find(item => item.grantId === value.grantId);
  if (grant === undefined || grant.domain !== "tool" || grant.status !== "open" || grant.budgetId === undefined
    || grant.claim?.claimId !== value.claimId || !Number.isFinite(Date.parse(issuedAt))
    || Date.parse(grant.claim.expiresAt) <= Date.parse(issuedAt)) return false;

  const issue = state.learningIssues?.find(item => item.issueId === grant.issueId);
  const centralJob = state.jobs.find(item => item.jobId === grant.jobId);
  const root = state.centralLearningBudgets?.find(item => item.budgetId === grant.budgetId);

  return issue !== undefined && issue.scope === grant.scope && issue.revision === value.expectedIssueRevision
    && issue.decision.kind === "focused_learning" && issue.decision.revision === grant.focusRevision
    && issue.grantId === grant.grantId && issue.jobId === grant.jobId && root?.scope === grant.scope
    && centralJob?.state === "running" && centralJob.coordination?.grantId === grant.grantId
    && issue.reports.some(report => "subsystem" in report.source && report.source.subsystem === "tool" && report.source.versionId === job.jobId)
    && isManagedToolCheckpointContinuation(state, job.jobId, value.resultRef);
}
