import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import type { SkillBoardAccess } from "./board.js";
import type { SkillControlResult, SkillCoordinationOptions, SkillDispatchResult } from "./contracts.js";
import { readSkillReviewOutcome } from "./review-outcome.js";

export type SkillExpiredRecoveryResult = SkillControlResult<{
  readonly status: "unchanged" | "ready" | "busy" | "recovered" | "reconciliation_required";
  readonly reason: string; readonly sourceRefs: readonly string[]; readonly dispatch?: SkillDispatchResult;
}>;

/** Expiration is not evidence that a native review was unsent. Only an empty
 * original reservation history permits another review; confirmed outcomes finish
 * locally and all other sent work closes with an explicit reconciliation need. */
export async function recoverExpiredSkillReview(options: SkillCoordinationOptions, board: SkillBoardAccess,
  issueId: string, signal: AbortSignal, mode: "prepare" | "dispatch" = "prepare"): Promise<SkillExpiredRecoveryResult> {
  if (signal.aborted) return { ok: false, reason: "learning_aborted" };

  const loaded = await board.load();
  if (!loaded.ok) return loaded;

  const issue = loaded.state.learningIssues?.find(item => item.issueId === issueId && item.scope === options.scope);
  const current = issue?.jobId === undefined ? undefined : coordinationForJob(loaded.state, issue.jobId);
  if (issue === undefined || learningIssueOwner(issue) !== "skill"
    || current !== undefined && (current.grant.domain !== "skill" || current.grant.scope !== options.scope)) {
    return { ok: false, reason: "hermes_managed_source_owner" };
  }

  const unchanged = { ok: true as const, status: "unchanged" as const, reason: "hermes_review_no_expired_claim", sourceRefs: [issueId] };

  if (current === undefined || current.grant.status !== "open" || current.job.state !== "running" || current.grant.claim === undefined) return unchanged;

  const { grant, job } = current, claim = grant.claim;
  if (claim === undefined) return unchanged;

  const sourceRefs = [issueId, grant.grantId, job.jobId, claim.claimId];

  if (Date.parse(claim.expiresAt) > Date.parse(options.now())) return { ok: true, status: "busy", reason: "hermes_review_live_owner", sourceRefs };

  if (issue.decision.kind !== "focused_learning" || grant.focusRevision !== issue.decision.revision) return { ok: false, reason: "hermes_managed_binding_stale" };

  const recorded = readSkillReviewOutcome(loaded.state, { schemaVersion: 1, scope: options.scope, issueId,
    grantId: grant.grantId, jobId: job.jobId, claimId: claim.claimId, attempt: job.attempt, focusRevision: grant.focusRevision,
    reservationIds: grant.reservations.map(item => item.reservationId) });
  if (!recorded.ok) return recorded;

  if (recorded.outcome === undefined && grant.reservations.length === 0 && mode === "dispatch") {
    return { ok: true, status: "ready", reason: "hermes_review_expired_unsent", sourceRefs };
  }

  if (signal.aborted) return { ok: false, reason: "learning_aborted" };

  const claimId = `skill-recovery:${contentHashOf([job.jobId, job.attempt + 1, options.ownerId])}`;
  const claimed = await board.send({ kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, expectedIssueRevision: issue.revision,
    claimId, ownerId: options.ownerId, expiresAt: new Date(Date.parse(options.now()) + 600_000).toISOString() });
  if (!claimed.ok) return claimed;

  if (claimed.duplicate) return { ok: true, status: "busy", reason: "hermes_review_recovery_claim_already_owned", sourceRefs };

  if (recorded.outcome === undefined && grant.reservations.length === 0) {
    const yielded = await board.send({ kind: "finish", jobId: job.jobId, claimId, expectedIssueRevision: issue.revision,
      result: { kind: "yielded", reason: "hermes_review_expired_unsent" } });
    return yielded.ok ? { ok: true, status: "ready", reason: "hermes_review_expired_unsent", sourceRefs }
      : yielded;
  }

  const result = recorded.outcome?.result ?? { kind: "failed" as const, reason: "hermes_review_reconciliation_required" };
  const finished = await board.send({ kind: "finish", jobId: job.jobId, claimId, expectedIssueRevision: issue.revision, result });
  if (!finished.ok) return finished;

  const after = finished.state.centralLearningGrants?.find(item => item.grantId === grant.grantId);
  const dispatch: SkillDispatchResult = { ok: true, status: result.kind, issueId, jobId: job.jobId, grantId: grant.grantId, result,
    ...(after === undefined ? {} : { remaining: centralLearningRemaining(after) }) };

  return { ok: true, status: recorded.outcome === undefined ? "reconciliation_required" : "recovered",
    reason: recorded.outcome === undefined ? "hermes_review_reconciliation_required" : "hermes_review_confirmed_outcome_recovered",
    sourceRefs: [...sourceRefs, ...(recorded.outcomeRef === undefined ? [] : [recorded.outcomeRef])], dispatch };
}
