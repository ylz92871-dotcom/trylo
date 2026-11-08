import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { toolLearningFundingClaimBelongsTo, toolLearningFundingClaimId, toolLearningFundingClaimMatches } from "../domain/evolution/funding-identity.js";
import type { ToolLearningResult } from "../domain/evolution/pipeline.js";
import { selectToolFocusedSource } from "./central-source.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";
import { resultForJob } from "./pipeline-records.js";
import { recoverExpiredToolChild } from "./expired-child-recovery.js";
import { retainUnstartedToolConstruction } from "./committed-construction-recovery.js";

type Options = { readonly boardRoot: string; readonly scope: string; readonly centralScope: string; readonly now: () => number };

type Recovery = { readonly issueId: string; readonly status: "idle" | "busy" | "recovered" | "inspection_required";
  readonly reason?: string; readonly sourceRefs?: readonly string[]; readonly operatorRoute?: string };

type Result = { readonly ok: true; readonly results: readonly Recovery[] } | { readonly ok: false; readonly reason: string };

function replayConfirmedTerminal(board: BoardStore, result: ToolLearningResult) {
  // Match pipeline-worker's original command and terminal mapping exactly.
  const base = { commandId: `${result.jobId}:terminal:${result.attempt}`, issuedAt: result.occurredAt, jobId: result.jobId };
  return board.apply(result.outcome === "waiting_approval" || result.outcome === "waiting_evidence" || result.outcome === "succeeded"
    ? { ...base, type: "complete_job", next: result.outcome }
    : { ...base, type: "fail_job", terminal: result.outcome });
}

/** Reconcile only the original task's confirmed result and lease. A missing
 * pipeline result cannot prove external work did not run, even with zero model
 * reservations. It stays inspectable and is never turned into a fresh attempt. */
export async function recoverExpiredToolLearning(options: Options, signal: AbortSignal, issueId?: string): Promise<Result> {
  if (signal.aborted) return { ok: false, reason: "learning_aborted" };

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const issues = (loaded.state.learningIssues ?? []).filter(issue => issue.scope === options.centralScope
    && (issueId === undefined || issue.issueId === issueId) && issue.reports.every(report => "subsystem" in report.source && report.source.subsystem === "tool"));
  const results: Recovery[] = [];

  for (const original of issues) {
    if (signal.aborted) return { ok: false, reason: "learning_aborted" };

    const recovered = await withBoardWriter(options.boardRoot, async board => {
      const current = await board.load();
      if (!current.ok) return { ok: false as const, reason: current.reason };

      const issue = current.state.learningIssues?.find(item => item.issueId === original.issueId);
      if (issue?.decision.kind !== "focused_learning") return { ok: true as const, status: "idle" as const };

      const source = selectToolFocusedSource(current.state, issue, options.scope, options.centralScope);
      if (!source.ok) return { ok: false as const, reason: source.code };

      const grant = current.state.centralLearningGrants?.find(item => item.grantId === source.grantId);
      const budgetJob = current.state.jobs.find(item => item.jobId === grant?.jobId);

      if (grant === undefined || grant.status !== "open") return { ok: true as const, status: "idle" as const };

      if (!toolFundingGrantMatches(current.state, source.plan, grant) || issue.grantId !== grant.grantId || issue.jobId !== grant.jobId
        || grant.focusRevision !== issue.decision.revision) return { ok: false as const, reason: "tool_expired_recovery_binding" };

      if (grant.claim === undefined) {
        const children = current.state.jobs.filter(job => job.domain === "tool" && job.scope === options.scope && job.state === "running"
          && (job.jobId.startsWith("tool-adaptation_v1_") || job.jobId.startsWith("tool-acquisition-inquiry_v1_"))
          && grant.reservations.some(reservation => toolLearningFundingClaimBelongsTo(source.plan, job.jobId, job.attempt, reservation.claimId)));
        if (children.length > 1) return { ok: false as const, reason: "tool_expired_child_binding" };

        if (children[0] !== undefined) {
          const child = await recoverExpiredToolChild(board, current.state, { ...options, originalJobId: source.jobId,
            plan: source.plan, childJobId: children[0].jobId });
          if (!child.ok) return { ok: false as const, reason: child.code };
          return { ...child, status: child.confirmed ? "recovered" as const : "inspection_required" as const };
        }

        let result = resultForJob(current.state, source.jobId, source.job.attempt);

        if (source.job.state !== "running") return { ok: true as const, status: "idle" as const };

        if (result === undefined) {
          const checkpoint = await retainUnstartedToolConstruction(board, current.state, { job: source.job, plan: source.plan, grant,
            issuedAt: new Date(options.now()).toISOString() });
          if (!checkpoint.ok) return { ok: false as const, reason: checkpoint.code };
          result = checkpoint.result;
        }

        if (result === undefined) return { ok: true as const, status: "inspection_required" as const };

        // An expired lease may already have been yielded when the original
        // worker's confirmed result arrives. The canonical source/focus/grant
        // was rechecked under this writer; replay needs no claim or new funds.
        const terminal = await replayConfirmedTerminal(board, result);

        return terminal.ok ? { ok: true as const, status: "recovered" as const }
          : { ok: false as const, reason: terminal.reason };
      }

      if (budgetJob?.state !== "running") return { ok: false as const, reason: "tool_expired_recovery_binding" };

      if (Date.parse(grant.claim.expiresAt) > options.now()) return { ok: true as const, status: "busy" as const };

      if (toolLearningFundingClaimMatches(source.plan, source.jobId, source.job.attempt, grant.claim)) {
        const checkpoint = await retainUnstartedToolConstruction(board, current.state, { job: source.job, plan: source.plan, grant,
          issuedAt: new Date(options.now()).toISOString() });
        if (!checkpoint.ok) return { ok: false as const, reason: checkpoint.code };
      }

      let recoveredChild: Awaited<ReturnType<typeof recoverExpiredToolChild>> | undefined;

      if (!toolLearningFundingClaimMatches(source.plan, source.jobId, source.job.attempt, grant.claim)) {
        recoveredChild = await recoverExpiredToolChild(board, current.state, { ...options, originalJobId: source.jobId,
          plan: source.plan, claim: grant.claim });
        if (!recoveredChild.ok) return { ok: false as const, reason: recoveredChild.code };
      }

      const parent = recoveredChild?.ok ? recoveredChild.child : source.job;
      const claimId = toolLearningFundingClaimId(source.plan, parent.jobId, parent.attempt, budgetJob.attempt + 1);
      const action = { kind: "claim" as const, jobId: budgetJob.jobId, expectedAttempt: budgetJob.attempt, claimId,
        ownerId: `tool-recovery:${source.jobId}`, expiresAt: new Date(options.now() + 120_000).toISOString(), expectedIssueRevision: issue.revision };
      const claimed = await board.apply({ type: "coordinate_learning", commandId: `tool-recovery:${contentHashOf(action)}`,
        issuedAt: new Date(options.now()).toISOString(), action });
      if (!claimed.ok) return { ok: false as const, reason: claimed.reason };

      const result = resultForJob(claimed.state, source.jobId, source.job.attempt);
      const missing = recoveredChild?.ok && !recoveredChild.confirmed || source.job.state === "running" && result === undefined;

      if (recoveredChild === undefined && source.job.state === "running" && result !== undefined) {
        const applied = await replayConfirmedTerminal(board, result);
        if (!applied.ok) return { ok: false as const, reason: applied.reason };
      }

      const yielded = await board.apply({ type: "coordinate_learning",
        commandId: `tool-recovery-yield:${contentHashOf([budgetJob.jobId, claimId])}`, issuedAt: new Date(options.now()).toISOString(),
        action: { kind: "finish", jobId: budgetJob.jobId, claimId, expectedIssueRevision: issue.revision, result: { kind: "yielded",
          reason: missing ? "tool_expired_sent_attempt_requires_inspection" : "tool_expired_result_locally_recovered" } } });

      return yielded.ok ? { ok: true as const, status: missing ? "inspection_required" as const : "recovered" as const,
        ...(missing ? { reason: recoveredChild?.ok && !recoveredChild.confirmed ? recoveredChild.reason : "tool_expired_sent_attempt_requires_inspection" } : {}),
        ...(recoveredChild?.ok ? { sourceRefs: recoveredChild.sourceRefs } : {}),
        ...(recoveredChild?.ok && !recoveredChild.confirmed ? { operatorRoute: recoveredChild.operatorRoute } : {}) }
        : { ok: false as const, reason: yielded.reason };
    });
    if (!recovered.ok) return { ok: false, reason: recovered.reason };

    results.push({ issueId: original.issueId, status: recovered.status, ...("reason" in recovered ? { reason: recovered.reason } : {}),
      ...("sourceRefs" in recovered ? { sourceRefs: recovered.sourceRefs } : {}), ...("operatorRoute" in recovered ? { operatorRoute: recovered.operatorRoute } : {}) });
  }

  return { ok: true, results };
}
