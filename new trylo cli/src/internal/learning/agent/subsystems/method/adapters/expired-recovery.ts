import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { applyReviewEffects } from "../orchestration/experience-effects.js";
import type { ExperienceRuntimeOptions } from "../orchestration/experience-runtime.js";
import { methodFocusedTarget } from "./central-source.js";
import { methodFundingIdentity } from "./funding-identity.js";

type Options = { readonly boardRoot: string; readonly scope: string; readonly workspaceId: string;
  readonly turnId: string; readonly now: () => string; readonly runtime: ExperienceRuntimeOptions };

type Recovery = { readonly issueId: string; readonly status: "idle" | "busy" | "recovered"; readonly resultRefs: readonly string[] };

type Result = { readonly ok: true; readonly results: readonly Recovery[] } | { readonly ok: false; readonly reason: string };

/** Maintenance only: takeover uses the original Board claim transition, which
 * preserves unresolved reservations as unknown. No model or new grant is created. */
export async function recoverExpiredMethodLearning(options: Options, signal: AbortSignal, issueId?: string): Promise<Result> {
  if (signal.aborted) return { ok: false, reason: "learning_aborted" };

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const issues = (loaded.state.learningIssues ?? []).filter(issue => (issueId === undefined || issue.issueId === issueId)
    && (issue.scope === options.scope || issue.scope === options.workspaceId) && methodFocusedTarget(issue) !== undefined);
  const results: Recovery[] = [];

  for (const original of issues) {
    if (signal.aborted) return { ok: false, reason: "learning_aborted" };

    const acquired = await withBoardWriter(options.boardRoot, async board => {
      const current = await board.load();
      if (!current.ok) return { ok: false as const, reason: current.reason };

      const issue = current.state.learningIssues?.find(item => item.issueId === original.issueId);
      const target = issue === undefined ? undefined : methodFocusedTarget(issue);
      if (issue === undefined || target === undefined || issue.decision.kind !== "focused_learning") return { ok: true as const, status: "idle" as const };

      const selected = methodFundingIdentity(current.state.centralLearningGrants ?? [], options.workspaceId, options.scope, target);
      if (!selected.ok) return selected;

      const grant = current.state.centralLearningGrants?.find(item => item.grantId === selected.grantId && item.grantId === issue.grantId);
      const job = current.state.jobs.find(item => item.jobId === grant?.jobId);

      if (grant === undefined || grant.status !== "open" || grant.claim === undefined) return { ok: true as const, status: "idle" as const };

      if (grant.domain !== "prompt" || grant.scope !== selected.scope || grant.issueId !== issue.issueId || issue.scope !== selected.scope
        || issue.jobId !== grant.jobId || grant.focusRevision !== issue.decision.revision || job?.domain !== "prompt"
        || job.scope !== grant.scope || job.state !== "running" || job.coordination?.grantId !== grant.grantId
        || job.coordination.issueId !== issue.issueId) return { ok: false as const, reason: "method_expired_recovery_binding" };

      if (Date.parse(grant.claim.expiresAt) > Date.parse(options.now())) return { ok: true as const, status: "busy" as const };

      const claimId = `method-recovery:${contentHashOf([grant.grantId, grant.claim.claimId, job.attempt])}`;
      const action = { kind: "claim" as const, jobId: job.jobId, expectedAttempt: job.attempt, claimId,
        ownerId: `method-recovery:${options.turnId}`, expiresAt: new Date(Date.parse(options.now()) + 120_000).toISOString(),
        expectedIssueRevision: issue.revision };
      const claimed = await board.apply({ type: "coordinate_learning", commandId: `method-recovery:${contentHashOf(action)}`,
        issuedAt: options.now(), action });

      return claimed.ok ? { ok: true as const, status: "claimed" as const, claimId, jobId: job.jobId, target,
        focusRevision: issue.decision.revision }
        : { ok: false as const, reason: claimed.reason };
    });
    if (!acquired.ok) return { ok: false, reason: acquired.reason };

    if (acquired.status !== "claimed") {
      results.push({ issueId: original.issueId, status: acquired.status, resultRefs: [] });
      continue;
    }

    let failure: string | undefined;
    let resultRefs: readonly string[] = [];

    try {
      let view = await options.runtime.store.load();
      const reviews = view.facts.filter(fact => fact.kind === "review" && fact.versionId === acquired.target.versionId && fact.scopeId === acquired.target.scopeId);

      for (const review of reviews) {
        if (review.kind !== "review" || signal.aborted) break;
        view = await applyReviewEffects(options.runtime, view, review, signal);
      }

      resultRefs = view.facts.filter(fact => fact.versionId === acquired.target.versionId).map(fact => fact.factId);
    } catch { failure = "method_expired_effect_recovery_failed"; }

    // Even a failed local effect leaves a real snapshot reservation in place.
    // Releasing this recovery lease cannot authorize another draw on that snapshot.
    const released = await withBoardWriter(options.boardRoot, async board => {
      const current = await board.load();
      if (!current.ok) return { ok: false as const, reason: current.reason };

      const issue = current.state.learningIssues?.find(item => item.issueId === original.issueId);
      if (issue?.decision.kind !== "focused_learning" || issue.decision.revision !== acquired.focusRevision
        || issue.jobId !== acquired.jobId) return { ok: false as const, reason: "learning_issue_conflict" };

      return board.apply({ type: "coordinate_learning",
        commandId: `method-recovery-yield:${contentHashOf([acquired.jobId, acquired.claimId, issue.revision])}`, issuedAt: options.now(),
        action: { kind: "finish", jobId: acquired.jobId, claimId: acquired.claimId, expectedIssueRevision: issue.revision,
          result: { kind: "yielded", reason: failure ?? "method_expired_claim_locally_recovered" } } });
    });
    if (!released.ok) return { ok: false, reason: released.reason };

    if (failure !== undefined) return { ok: false, reason: failure };

    results.push({ issueId: original.issueId, status: "recovered", resultRefs });
  }

  return { ok: true, results };
}
