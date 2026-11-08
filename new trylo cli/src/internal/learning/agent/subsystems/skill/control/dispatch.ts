import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningRemaining, type CentralLearningWorkResult } from "../../../../control/coordination-contract.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { isCentralLearningWorkResult } from "../../../../control/coordination-parse.js";
import { skillCentralFunding } from "./funding.js";
import type { SkillBoardAccess } from "./board.js";
import type { SkillCentralWorker, SkillCoordinationOptions, SkillDispatchResult } from "./contracts.js";
import { skillFailureCode } from "../failure.js";
import { recoverExpiredSkillReview } from "./expired-recovery.js";
import { recordSkillReviewOutcome } from "./review-outcome.js";

type Work = { readonly signal: AbortSignal; readonly worker: SkillCentralWorker;
  /** Exact managed dispatch must not select a replacement grant for the same issue. */
  readonly expectedGrantId?: string; readonly expectedIssueRevision?: number };

const failure = (reason: string) => ({ ok: false as const, reason });

/** Dispatches already funded work. It cannot decide an issue or allocate quota. */
export function createSkillDispatcher(options: SkillCoordinationOptions, board: SkillBoardAccess) {
  const running = new Map<string, string>();
  const run = async (input: Work & { readonly issueId: string }): Promise<SkillDispatchResult> => {
    if (input.signal.aborted) return failure("learning_aborted");

    if (!options.ownerId.trim() || options.ownerId.length > 200) return failure("claim_owner_required");

    const loaded = await board.load();
    if (!loaded.ok) return loaded;

    const issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === options.scope
      && learningIssueOwner(item) === "skill");
    if (issue === undefined) return failure("learning_issue_not_found");

    const job = loaded.state.jobs.find(item => item.jobId === issue.jobId && item.domain === "skill");
    if (job === undefined) return { ok: true, status: "idle" };

    const current = coordinationForJob(loaded.state, job.jobId);
    if (current === undefined || current.grant.domain !== "skill" || current.grant.status !== "open"
      || current.issue.decision.kind !== "focused_learning") return { ok: true, status: "idle" };

    if (input.expectedGrantId !== undefined && (current.grant.grantId !== input.expectedGrantId
      || issue.grantId !== input.expectedGrantId || current.grant.focusRevision !== current.issue.decision.revision)
      || input.expectedIssueRevision !== undefined && issue.revision !== input.expectedIssueRevision) {
      return failure("hermes_managed_binding_stale");
    }

    if (running.has(job.jobId) || job.state === "running" && current.grant.claim !== undefined
      && Date.parse(current.grant.claim.expiresAt) > Date.parse(options.now())) return { ok: true, status: "busy", jobId: job.jobId };

    if (job.state !== "queued" && job.state !== "running") return { ok: true, status: "idle" };

    if (job.state === "running" && current.grant.claim !== undefined) {
      const recovered = await recoverExpiredSkillReview(options, board, issue.issueId, input.signal, "dispatch");
      if (!recovered.ok) return recovered;
      if (recovered.dispatch !== undefined) return recovered.dispatch;
      if (recovered.status === "busy") return { ok: true, status: "busy", jobId: job.jobId };
    }

    const claimId = `skill-claim:${contentHashOf([job.jobId, job.attempt + 1, options.ownerId])}`;
    // The persisted claim owns dispatch; this process's running map is only local coordination.
    const claimed = await board.send({ kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId,
      ...(input.expectedIssueRevision === undefined ? {} : { expectedIssueRevision: input.expectedIssueRevision }),
      ownerId: options.ownerId, expiresAt: new Date(Date.parse(options.now()) + 600_000).toISOString() });
    if (!claimed.ok) return claimed;

    if (claimed.duplicate) return { ok: true, status: "busy", jobId: job.jobId };

    const funded = coordinationForJob(claimed.state, job.jobId);
    if (funded === undefined) return failure("learning_grant_not_found");

    running.set(job.jobId, issue.issueId);

    try {
      let result: CentralLearningWorkResult;

      if (input.signal.aborted || !board.enabled()) result = { kind: "cancelled", reason: "learning_aborted" };
      else {
        try { result = await input.worker({ issue: funded.issue, grant: funded.grant, claimId,
          remaining: centralLearningRemaining(funded.grant), funding: skillCentralFunding(options, board, { grantId: funded.grant.grantId, claimId }),
          signal: input.signal }); }
        catch (error) { result = { kind: "failed", reason: skillFailureCode(error, "skill_learning_worker_failed") }; }

        if (!isCentralLearningWorkResult(result)) result = { kind: "failed", reason: "invalid_learning_work_result" };

        if (input.signal.aborted || !board.enabled()) {
          const pendingRefs = "resultRefs" in result ? result.resultRefs?.filter(ref => ref.startsWith("hermes-pending:skills:")) : undefined;
          result = { kind: result.kind === "failed" ? "failed" : "cancelled",
            reason: result.kind === "failed" ? result.reason : "learning_aborted",
            ...(pendingRefs === undefined || pendingRefs.length === 0 ? {} : { resultRefs: pendingRefs }) };
        }
      }

      const recorded = await recordSkillReviewOutcome(options, { jobId: funded.job.jobId, grantId: funded.grant.grantId, claimId, result });
      if (!recorded.ok) return recorded;

      const finished = await board.send({ kind: "finish", jobId: funded.job.jobId, claimId, result }, result.kind === "cancelled" || !board.enabled());
      if (!finished.ok) return finished;

      const grant = finished.state.centralLearningGrants?.find(item => item.grantId === funded.grant.grantId);

      return { ok: true, status: result.kind, issueId: funded.issue.issueId, jobId: funded.job.jobId, grantId: funded.grant.grantId,
        result, ...(grant === undefined ? {} : { remaining: centralLearningRemaining(grant) }) };
    } finally {
      running.delete(job.jobId);
    }
  };

  return {
    run,
    recoverExpired: (issueId: string, signal: AbortSignal) => [...running.values()].includes(issueId)
      ? Promise.resolve({ ok: true as const, status: "busy" as const, reason: "hermes_review_local_worker_running", sourceRefs: [issueId] })
      : recoverExpiredSkillReview(options, board, issueId, signal),
    async dispatchFunded(input: Work): Promise<SkillDispatchResult> {
      if (input.signal.aborted) return failure("learning_aborted");

      const loaded = await board.load();
      if (!loaded.ok) return loaded;

      // Board order is scheduling order, never a new ranking of lessons or skills.
      // run() re-reads and claims with CAS, so this snapshot confers no authority.
      const candidates = loaded.state.jobs.filter(job => job.domain === "skill" && job.scope === options.scope)
        .flatMap(job => {
          const value = coordinationForJob(loaded.state, job.jobId);
          return value !== undefined && value.grant.domain === "skill" && value.grant.scope === options.scope && value.grant.status === "open"
            && value.issue.scope === options.scope && value.issue.decision.kind === "focused_learning"
            && learningIssueOwner(value.issue) === "skill" ? [value] : [];
        });
      const ready = candidates.find(({ job, grant }) => job.state === "queued"
        || job.state === "running" && grant.claim !== undefined && Date.parse(grant.claim.expiresAt) <= Date.parse(options.now()));
      if (ready === undefined) return { ok: true, status: candidates.some(item => item.job.state === "running") ? "busy" : "idle" };

      return run({ ...input, issueId: ready.issue.issueId });
    },
  };
}
