import type { CentralLearningExecutionPort, CentralStagePreparation, CentralFundedStage, CentralStageObservation } from "./contracts.js";
import type { CentralLearningAllowance, LearningIssue } from "../../learning/control/coordination-contract.js";
import type { BoardState } from "../../learning/control/state.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "../../learning/control/coordination-parse.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { identity } from "../../validation/json-shape.js";
import type { SkillManagedRuntime, SkillManagedSource } from "../../learning/agent/subsystems/skill/index.js";
import { inspectCentralFundedStage, isCentralFundedStage } from "./funded-stage.js";
import { readPreparedCentralStageContext } from "./prepared-context.js";

type Options = {
  readonly board: Pick<BoardStore, "load">;
  readonly scope: string;
  readonly boardRoot?: string;
  /** The original CLI/native runtime, including its funded provider and Permission. */
  readonly runtime: SkillManagedRuntime;
};

/** A later explicit focus can commission another review after a known failure.
 * The old grant and its receipts remain immutable. Unknown work and existing
 * native proposals must still be reconciled by their original owner. */
function reviewOwnership(board: BoardState, issue: LearningIssue) {
  const previous = board.centralLearningGrants?.find(item => item.grantId === issue.grantId);
  const job = board.jobs.find(item => item.jobId === issue.jobId);
  const refocused = previous?.status === "closed" && issue.decision.kind === "focused_learning"
    && issue.decision.revision > previous.focusRevision && previous.claim === undefined
    && previous.closedReason !== "hermes_review_reconciliation_required"
    && previous.reservations.every(item => item.state === "settled" && item.usage?.kind === "reported")
    && job !== undefined && ["failed", "cancelled", "expired"].includes(job.state)
    && !job.coordination?.resultRefs?.some(ref => ref.startsWith("hermes-pending:skills:"));

  return { refocused, grant: refocused ? undefined : previous, job: refocused ? undefined : job };
}

function policyRef(reserve: { readonly tokens: number; readonly calls: number; readonly steps: number }, maxPromptChars: number): string {
  return `hermes-review-policy:${contentHashOf({ version: 1, reserve, maxPromptChars,
    process: "official-hermes-review-native-pending", boundary: "complete-review-package" })}`;
}

function offerFor(issueId: string, source: SkillManagedSource, allowance: CentralLearningAllowance) {
  const calls = Math.min(allowance.maxCalls, allowance.maxSteps);
  const reserve = { tokens: allowance.maxTokens, calls, steps: calls };
  const policy = policyRef(reserve, allowance.maxPromptChars);
  return { offerId: `hermes-offer:${contentHashOf([issueId, source.stageRef, policy])}`,
    owner: { plane: "agent" as const, domain: "skill" as const }, policyRef: policy,
    reserve, maxPromptChars: allowance.maxPromptChars };
}

/** Formal managed-skill adapter. It reaches the original review worker and its
 * existing pending approval/normal context paths; it never calls legacy learn(). */
export function createCentralSkillExecution(options: Options): CentralLearningExecutionPort {
  const unavailable = (reason: string, sourceRefs: readonly string[] = []): CentralStagePreparation => ({ status: "unavailable", reason, sourceRefs });
  return {
    domain: "skill",

    async nominate(signal) {
      if (signal.aborted) return [];

      let loaded = await options.board.load();
      if (!loaded.ok) throw new Error(loaded.reason);

      if (options.runtime.recoverManaged !== undefined) {
        for (const issue of loaded.state.learningIssues ?? []) {
          if (signal.aborted) return [];
          if (issue.scope !== options.scope || learningIssueOwner(issue) !== "skill" || issue.decision.kind !== "focused_learning") continue;
          const recovered = await options.runtime.recoverManaged(issue.issueId, signal);
          if (!recovered.ok) throw new Error(recovered.reason);
        }

        loaded = await options.board.load();
        if (!loaded.ok) throw new Error(loaded.reason);
      }

      return (loaded.state.learningIssues ?? []).filter(issue => issue.scope === options.scope && learningIssueOwner(issue) === "skill"
        && (issue.decision.kind === "unreviewed" || issue.decision.kind === "focused_learning")
        && reviewOwnership(loaded.state, issue).grant?.status !== "closed")
        .map(issue => issue.issueId);
    },

    async prepare(input, signal) {
      if (signal.aborted) return unavailable("learning_aborted");

      const operation = input.operationAllowance ?? input.authorizedAllowance;
      if (!identity(input.issueId) || !isCentralLearningGrantAllowance(input.authorizedAllowance)
        || !isCentralLearningAllowance(operation)) return unavailable("hermes_managed_input");

      let loaded = await options.board.load();
      if (!loaded.ok) return unavailable(loaded.reason);

      let issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === options.scope);
      if (issue === undefined || learningIssueOwner(issue) !== "skill") return unavailable("hermes_managed_source_owner");

      if (issue.decision.kind !== "focused_learning") return unavailable("learning_issue_not_focused");

      if (options.runtime.recoverManaged !== undefined) {
        const recovered = await options.runtime.recoverManaged(issue.issueId, signal);
        if (!recovered.ok) return unavailable(recovered.reason, issue.reports.flatMap(report => report.evidenceRefs));

        if (recovered.status === "busy") return { status: "waiting", reason: recovered.reason, sourceRefs: recovered.sourceRefs };

        loaded = await options.board.load();
        if (!loaded.ok) return unavailable(loaded.reason);

        issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === options.scope);

        if (issue === undefined || learningIssueOwner(issue) !== "skill") return unavailable("hermes_managed_source_owner");

        if (issue.decision.kind !== "focused_learning") return unavailable("learning_issue_not_focused");
      }

      const { grant, job, refocused } = reviewOwnership(loaded.state, issue);
      const refs = issue.reports.flatMap(report => report.evidenceRefs);

      if (grant !== undefined && (grant.status === "closed" || job !== undefined
        && ["succeeded", "failed", "cancelled", "expired"].includes(job.state))) {
        return { status: "terminal", reason: grant.closedReason === "hermes_review_reconciliation_required"
          ? grant.closedReason : "hermes_original_review_terminal", sourceRefs: refs };
      }

      if (grant !== undefined && grant.budgetId === undefined) return unavailable("hermes_unmanaged_grant_retained", refs);

      if (grant?.claim !== undefined || grant?.reservations.some(item => item.state === "reserved")
        || job?.state === "running" || job?.state === "waiting_evidence" || job?.state === "waiting_approval") {
        return { status: "waiting", reason: "hermes_original_review_pending", sourceRefs: refs };
      }

      const prepared = await options.runtime.prepareManaged(input.issueId, signal);
      if (prepared.status !== "ready") return prepared;

      const spent = grant === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(grant);
      const reviewAllowance: CentralLearningAllowance = { ...operation,
        maxTokens: Math.min(operation.maxTokens, input.authorizedAllowance.maxTokens - spent.tokens),
        maxCalls: Math.min(operation.maxCalls, input.authorizedAllowance.maxCalls - spent.calls),
        maxSteps: Math.min(operation.maxSteps, input.authorizedAllowance.maxSteps - spent.steps),
        maxPromptChars: Math.min(operation.maxPromptChars, input.authorizedAllowance.maxPromptChars) };
      if (!isCentralLearningAllowance(reviewAllowance)) return unavailable("learning_grant_exhausted", refs);

      const source = prepared.source, offer = offerFor(issue.issueId, source, reviewAllowance);

      return { status: "ready", stageRef: source.stageRef, policyRef: offer.policyRef, offer,
        ...(source.sourceContext === undefined ? {} : { sourceContext: source.sourceContext }),
        ...(source.policyFamily === undefined ? {} : { policyFamily: source.policyFamily }),
        authorizedAllowance: { ...input.authorizedAllowance }, source: {
          issueId: issue.issueId, grantId: refocused
            ? `central-skill-grant:${contentHashOf([options.scope, issue.issueId, source.stageRef, issue.decision.revision])}`
            : issue.grantId ?? `central-skill-grant:${contentHashOf([options.scope, issue.issueId, source.stageRef])}`,
          sourceBindingRef: source.sourceBindingRef, domainStage: { stageRef: source.stageRef, kind: "initial",
            policyRef: offer.policyRef, sourceReportId: source.sourceReportId,
            readiness: { kind: "ready", evidenceRefs: source.sourceRefs } },
        } };
    },

    async dispatch(input, signal) {
      if (signal.aborted) return { ok: false, reason: "learning_aborted" };

      if (!validDispatch(input)) return { ok: false, reason: "hermes_managed_dispatch_binding" };

      const loaded = await options.board.load();
      if (!loaded.ok) return { ok: false, reason: loaded.reason };

      const current = inspectCentralFundedStage(loaded.state, { scope: options.scope, domain: "skill", input });
      if (!current.ok) return current;

      let sourceContext = input.sourceContext;
      if (sourceContext !== undefined) {
        if (options.boardRoot === undefined) return { ok: false, reason: "central_stage_context_archive_unavailable" };
        const captured = await readPreparedCentralStageContext({ boardRoot: options.boardRoot, scope: options.scope, input });
        if (captured.status !== "ready") return { ok: false, reason: captured.reason };
        sourceContext = captured.context;
      }

      const source = await options.runtime.prepareManaged(input.issueId, signal, sourceContext);
      if (source.status !== "ready") return { ok: false, reason: source.reason };

      if (source.source.sourceBindingRef !== input.sourceBindingRef || source.source.stageRef !== input.stageRef
        || input.offer.offerId !== `hermes-offer:${contentHashOf([input.issueId, input.stageRef, input.policyRef])}`) {
        return { ok: false, reason: "hermes_managed_source_changed" };
      }

      // The dispatcher and claimed worker recheck the exact grant/revision/source.
      return options.runtime.runManaged({ issueId: input.issueId, grantId: input.grantId,
        expectedIssueRevision: input.expectedIssueRevision, sourceBindingRef: input.sourceBindingRef,
        stageResources: input.offer.reserve, maxPromptChars: input.offer.maxPromptChars,
        ...(sourceContext === undefined ? {} : { sourceContext }) }, signal);
    },

    async observe(input, signal): Promise<CentralStageObservation> {
      const pending = (reason: string): CentralStageObservation => ({ outcome: "pending", resultRefs: [],
        sourceRefs: validDispatch(input) ? [input.sourceBindingRef] : [], reason });

      if (signal.aborted) return pending("learning_aborted");

      if (!validDispatch(input)) return pending("hermes_managed_dispatch_binding");

      const loaded = await options.board.load();
      if (!loaded.ok) return pending(loaded.reason);

      const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === input.grantId);
      const job = loaded.state.jobs.find(item => item.jobId === grant?.jobId);
      if (grant === undefined || job === undefined || grant.issueId !== input.issueId || grant.scope !== options.scope
        || grant.domain !== "skill" || grant.budgetId === undefined || job.coordination?.grantId !== grant.grantId
        || job.coordination.issueId !== input.issueId) return pending("hermes_managed_result_binding");

      const refs = job.coordination.resultRefs ?? [];
      const pendingRefs = refs.filter(ref => ref.startsWith("hermes-pending:skills:") && ref.length > "hermes-pending:skills:".length);
      const sourceRefs = [input.sourceBindingRef, `hermes-review-receipt:${contentHashOf({ grantId: grant.grantId,
        jobId: job.jobId, resultRefs: refs, status: job.state })}`];

      // skillReviewWorkResult emits these locators only after native finish has
      // checked the actual pending ID, action and target. They remain historical
      // proposal receipts after approval/removal; they never prove later adoption.
      if (grant.status === "closed" && ["succeeded", "failed", "cancelled"].includes(job.state) && pendingRefs.length > 0) {
        return { outcome: "qualified", resultRefs: pendingRefs, sourceRefs,
          reason: job.state === "succeeded" ? "hermes_native_confirmed_proposal" : "hermes_native_confirmed_partial_proposal" };
      }

      const completeCosts = grant.reservations.every(item => item.state === "settled"
        && item.usage?.kind === "reported" && item.usage.totalTokens <= item.maxTokens);
      if (grant.status === "closed" && ["failed", "cancelled"].includes(job.state) && completeCosts
        && grant.closedReason !== "hermes_review_reconciliation_required") {
        return { outcome: "closed_no_result", resultRefs: refs, sourceRefs,
          reason: "hermes_native_closed_failed_without_confirmed_proposal" };
      }

      if (grant.status === "closed" && job.state === "succeeded" && completeCosts
        && refs.some(ref => ref.startsWith("hermes-review:skipped:") || ref.startsWith("hermes-review:") && ref.endsWith(":no_learning"))) {
        return { outcome: "closed_no_result", resultRefs: refs, sourceRefs, reason: "hermes_native_closed_without_proposal" };
      }

      return { ...pending("hermes_native_proposal_not_confirmed"), sourceRefs };
    },
  };
}

function validDispatch(input: CentralFundedStage): boolean {
  return isCentralFundedStage(input) && input.offer.owner.plane === "agent" && input.offer.owner.domain === "skill"
    && input.policyRef === policyRef(input.offer.reserve, input.offer.maxPromptChars);
}
