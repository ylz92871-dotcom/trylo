import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningRemaining, type CentralLearningAllowance, type CentralLearningGrant, type CoordinationAction } from "../../../../control/coordination-contract.js";
import type { CentralLearningResources } from "../../../../control/central-budget-contract.js";
import { TOOL_LEARNING_ALLOWANCE } from "../../../../control/tool-allowance.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { BoardState } from "../../../../control/state.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningJobId } from "../domain/evolution/pipeline.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { toolLearningFundingIdentity, toolLearningFundingClaimId, toolLearningFundingClaimMatches } from "../domain/evolution/funding-identity.js";
import { toolFundingInquiryFromBoard, toolFundingOriginFromBoard } from "./tool-funding-origin.js";
import { planForJob } from "./pipeline-records.js";
import { toolCentralSemanticFingerprint } from "./central-source.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";

export type ManagedToolFundingBinding = { readonly issueId: string; readonly grantId: string; readonly budgetId: string;
  readonly expectedIssueRevision: number;
  readonly semanticFingerprint?: string;
  readonly centralSourceContext?: CentralLearningSourceContext;
  /** A stage envelope is derived from canonical spend; it carries no mutable balance. */
  readonly stage?: { readonly chargedAtStart: CentralLearningResources; readonly allowance: CentralLearningAllowance } };

type Options = { readonly boardRoot: string; readonly scope: string; readonly now: () => number;
  /** Adapter seam; production always uses the original Board writer and lock. */
  readonly withWriter?: typeof withBoardWriter;
  /** Central issue scope is the workspace root; tool assets retain their legacy workspace ID. */
  readonly centralScope?: string;
  /** A Board-owned acquisition continuation spends the original task's remaining grant. */
  readonly continuationJobId?: string;
  /** Exact central application handoff. This branch cannot create or focus a source or fund another purse. */
  readonly managedBinding?: ManagedToolFundingBinding };

type Binding = { readonly plan: ToolLearningPlan; readonly parentJobId: string; readonly parentAttempt: number; readonly grantId: string;
  readonly budgetJobId: string; readonly claimId: string; readonly claimStep: number; readonly centralScope: string };

/** Tool-specific adapter to the existing central Board writer. No local spending ledger. */
export function createToolLearningFunding(options: Options) {
  let binding: Binding | undefined;
  const withWriter = options.withWriter ?? withBoardWriter;
  let pending: Promise<void> = Promise.resolve();
  const write = <T>(run: (store: BoardStore) => Promise<T>) => {
    // Forks share this funding owner. Queue only Board transactions, never model
    // streams; every transaction still acquires the original process-shared lock.
    const result = pending.then(() => withWriter(options.boardRoot, run));
    // Keep the queue live after failure. The caller receives the original result
    // unchanged; no failed or outcome-unknown transaction is replayed.
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const at = () => new Date(options.now()).toISOString();
  const apply = async (store: BoardStore, action: CoordinationAction, leaseEpoch?: number) => {
    const result = await store.apply({ type: "coordinate_learning", commandId: `tool-budget:${contentHashOf(leaseEpoch === undefined ? action : { action, leaseEpoch })}`, issuedAt: at(), action });
    return result.ok ? { ok: true as const, state: result.state, duplicate: result.idempotent } : pipelineFailure(result.reason, result.detail);
  };
  const inspect = async () => {
    if (binding === undefined) return pipelineFailure("learning_allowance_required", "No tool task has bound the central allowance");

    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const parent = loaded.state.jobs.find(job => job.jobId === binding!.parentJobId);
    const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === binding!.grantId);
    const issue = loaded.state.learningIssues?.find(item => item.issueId === grant?.issueId);
    if (parent?.state !== "running" || parent.attempt !== binding.parentAttempt || grant?.domain !== "tool" || grant.scope !== binding.centralScope
      || issue?.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision
      || options.managedBinding !== undefined && issue.revision !== options.managedBinding.expectedIssueRevision
      || grant.status !== "open" || grant.claim?.claimId !== binding.claimId || grant.claim.step !== binding.claimStep
      || Date.parse(grant.claim.expiresAt) <= options.now()) {
      return pipelineFailure("tool_learning_inactive", "Task or central allowance is no longer active");
    }

    const sourceFailure = managedSourceFailure(loaded.state, binding.plan, options.managedBinding);
    if (sourceFailure !== undefined) return sourceFailure;

    return { ok: true as const, grant, remaining: stageRemaining(grant, options.managedBinding?.stage) };
  };

  return {
    async allowance(plan: ToolLearningPlan) {
      if (plan.scope !== options.scope) return undefined;

      const result = await write(async store => {
        const loaded = await store.load();
        if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

        const originJobId = toolLearningJobId(plan), parentJobId = options.continuationJobId ?? originJobId;
        const parent = loaded.state.jobs.find(job => job.jobId === parentJobId);
        if (parent?.state !== "running" || parent.domain !== "tool" || parent.scope !== plan.scope) return pipelineFailure("tool_learning_inactive", "Learning task is not claimed");

        const canonicalPlan = planForJob(loaded.state, originJobId);
        if (canonicalPlan === undefined || contentHashOf(canonicalPlan) !== contentHashOf(plan)) return pipelineFailure("invalid_tool_funding_origin", "The task plan is not canonical");

        const sourceFailure = managedSourceFailure(loaded.state, plan, options.managedBinding);
        if (sourceFailure !== undefined) return sourceFailure;

        const inquiry = parentJobId.startsWith("tool-acquisition-inquiry_v1_");
        if (parentJobId !== originJobId && ((!parentJobId.startsWith("tool-adaptation_v1_") && !inquiry)
          || parent.observationId !== originJobId)) return pipelineFailure("invalid_continuation_binding", parentJobId);

        const root = inquiry ? toolFundingInquiryFromBoard(loaded.state, plan, parentJobId, parent.attempt) : toolFundingOriginFromBoard(loaded.state, plan);
        if (!root.ok) return root;

        if (options.managedBinding === undefined && loaded.state.centralLearningBudgets?.some(item => item.scope === (options.centralScope ?? options.scope))) {
          return pipelineFailure("tool_central_dispatch_required", "An active central root requires its exact managed stage dispatcher");
        }

        const existingOnly = parentJobId !== originJobId || plan.fundingOrigin !== undefined || plan.researchOrigin !== undefined || options.managedBinding !== undefined;
        const { identity, issueId, grantId } = toolLearningFundingIdentity(plan);

        if (options.managedBinding !== undefined
          && (options.managedBinding.issueId !== issueId || options.managedBinding.grantId !== grantId)) {
          return pipelineFailure("tool_managed_funding_binding", "The worker does not own this exact centrally funded task");
        }

        let state = loaded.state;
        let issue = state.learningIssues?.find(item => item.issueId === issueId);
        const centralScope = options.centralScope ?? options.scope;
        if (issue !== undefined && issue.scope !== centralScope && issue.scope !== options.scope) {
          return pipelineFailure("learning_scope_mismatch", "The existing tool issue belongs to another central workspace");
        }

        if (existingOnly && (issue === undefined || state.centralLearningGrants?.find(item => item.grantId === grantId) === undefined)) {
          return pipelineFailure("learning_grant_not_found", "An acquisition continuation requires its existing original lifetime grant");
        }

        if (issue === undefined) {
          const reported = await apply(store, toolSourceReport(plan, centralScope));
          if (!reported.ok) return reported;
          state = reported.state;
          issue = state.learningIssues?.find(item => item.issueId === issueId);
        }

        if (!existingOnly && issue?.decision.kind === "unreviewed") {
          const decided = await apply(store, { kind: "decide", issueId, expectedRevision: issue.revision, decision: "focused_learning",
            reason: "Tool learning opt-in nominates this durable task under the central bounded tool allowance.", sourceRefs: plan.trigger.evidenceRefs });
          if (!decided.ok) return decided;
          state = decided.state;
          issue = state.learningIssues?.find(item => item.issueId === issueId);
        }

        if (issue?.decision.kind !== "focused_learning") return pipelineFailure("learning_issue_not_focused", issueId);

        let grant = state.centralLearningGrants?.find(item => item.grantId === grantId);
        if (grant === undefined) {
          const funded = await apply(store, { kind: "fund", domain: "tool", issueId, expectedRevision: issue.revision, grantId, allowance: TOOL_LEARNING_ALLOWANCE });
          if (!funded.ok) return funded;
          state = funded.state;
          grant = state.centralLearningGrants?.find(item => item.grantId === grantId);
        }

        if (grant?.domain !== "tool" || grant.scope !== issue.scope || grant.status !== "open" || grant.issueId !== issueId
          || grant.focusRevision !== issue.decision.revision) return pipelineFailure("learning_grant_closed", grantId);

        if (options.managedBinding !== undefined && (grant.budgetId !== options.managedBinding.budgetId || grant.scope !== centralScope)) {
          return pipelineFailure("tool_managed_funding_binding", "The grant is not bound to the committed central root");
        }

        const budgetJobId = grant.jobId;
        const budgetJob = state.jobs.find(job => job.jobId === budgetJobId);
        if (budgetJob === undefined) return pipelineFailure("learning_grant_not_found", grantId);

        if (grant.claim === undefined || !toolLearningFundingClaimMatches(plan, parentJobId, parent.attempt, grant.claim)
          || Date.parse(grant.claim.expiresAt) <= options.now()) {
          const claimId = toolLearningFundingClaimId(plan, parentJobId, parent.attempt, budgetJob.attempt + 1);
          const claimed = await apply(store, { kind: "claim", jobId: budgetJob.jobId, expectedAttempt: budgetJob.attempt, claimId,
            ownerId: `tool:${identity}`, expiresAt: new Date(options.now() + 600_000).toISOString(),
            ...(options.managedBinding === undefined ? {} : { expectedIssueRevision: options.managedBinding.expectedIssueRevision }) });
          if (!claimed.ok) return claimed;
          grant = claimed.state.centralLearningGrants?.find(item => item.grantId === grantId)!;
        }

        const claim = grant.claim;
        if (claim === undefined || !toolLearningFundingClaimMatches(plan, parentJobId, parent.attempt, claim)) return pipelineFailure("learning_claim_conflict", parentJobId);

        binding = { plan, parentJobId, parentAttempt: parent.attempt, grantId, claimId: claim.claimId, claimStep: claim.step, budgetJobId: grant.jobId, centralScope: issue.scope };

        return { ok: true as const, grant };
      });
      if (!result.ok) return undefined;

      return budgetOf(result.grant, options.managedBinding?.stage);
    },
    inspect,
    async renew() {
      const current = await inspect();
      if (!current.ok || binding === undefined) return current;

      if (Date.parse(current.grant.claim!.expiresAt) >= options.now() + 600_000) return { ok: true as const };

      const selected = binding;

      return write(async store => {
        const loaded = await store.load();
        if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

        const parent = loaded.state.jobs.find(job => job.jobId === selected.parentJobId);
        const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === selected.grantId), claim = grant?.claim;
        if (parent?.state !== "running" || parent.attempt !== selected.parentAttempt || claim?.claimId !== selected.claimId
          || claim.step !== selected.claimStep) return pipelineFailure("tool_learning_inactive", "The original worker no longer owns this lease");

        const sourceFailure = managedSourceFailure(loaded.state, selected.plan, options.managedBinding);
        if (sourceFailure !== undefined) return sourceFailure;

        return apply(store, { kind: "renew", jobId: selected.budgetJobId, claimId: selected.claimId, ownerId: claim.ownerId,
          expectedStep: selected.claimStep, expectedExpiresAt: claim.expiresAt, expiresAt: new Date(options.now() + 600_000).toISOString(),
          ...(options.managedBinding === undefined ? {} : { expectedIssueRevision: options.managedBinding.expectedIssueRevision }) });
      });
    },
    async reserve(reservationId: string, maxTokens: number) {
      const current = await inspect();
      if (!current.ok || binding === undefined) return current;

      const selected = binding;

      return write(async store => {
        const loaded = await store.load();
        if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

        const parent = loaded.state.jobs.find(job => job.jobId === selected.parentJobId);
        const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === selected.grantId);
        const issue = loaded.state.learningIssues?.find(item => item.issueId === grant?.issueId);
        if (parent?.state !== "running" || parent.attempt !== selected.parentAttempt || grant?.claim?.claimId !== selected.claimId
          || issue?.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision
          || grant.claim.step !== selected.claimStep) return pipelineFailure("tool_learning_inactive", "Task or central lease changed before reserving allowance");

        const sourceFailure = managedSourceFailure(loaded.state, selected.plan, options.managedBinding);
        if (sourceFailure !== undefined) return sourceFailure;

        const remaining = stageRemaining(grant, options.managedBinding?.stage);
        if (options.managedBinding?.stage !== undefined && !grant.reservations.some(item => item.reservationId === reservationId)
          && (maxTokens > remaining.tokens || remaining.calls < 1 || remaining.steps < 1)) {
          return pipelineFailure("learning_budget_exhausted", "The committed stage envelope is exhausted");
        }

        return apply(store, { kind: "reserve", grantId: selected.grantId, claimId: selected.claimId, reservationId, maxTokens });
      });
    },
    async settle(reservationId: string, usage: Extract<CoordinationAction, { kind: "settle" }>["usage"]) {
      if (binding === undefined) return pipelineFailure("learning_allowance_required", "Missing allowance binding");
      const current = binding;
      return write(store => apply(store, { kind: "settle", grantId: current.grantId, reservationId, usage }));
    },
    async release() {
      if (binding === undefined) return;

      const current = binding;
      binding = undefined;
      const result = await write(async store => {
        const loaded = await store.load();
        if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

        const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === current.grantId);

        // Settlement may already have closed an overrun grant and released its
        // lease. Cleanup must not obscure the original accounting outcome.
        if (grant?.status === "closed" && grant.claim === undefined) return { ok: true as const };

        if (grant?.claim?.claimId !== current.claimId || grant.claim.step !== current.claimStep) return pipelineFailure("learning_claim_conflict", "the actual central lease changed before release");

        return apply(store, { kind: "finish", jobId: current.budgetJobId, claimId: current.claimId,
          result: { kind: "yielded", reason: "tool_worker_boundary" } }, current.claimStep);
      });
      if (!result.ok) throw new Error(`tool_allowance_release:${"code" in result ? result.code : result.reason}`);
    },
  };
}

/** Nominate only a real immutable queue source. PA remains the focus owner. */
export async function nominateToolLearningSource(options: Pick<Options, "boardRoot" | "scope" | "centralScope" | "now">,
  plan: ToolLearningPlan, signal: AbortSignal) {
  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    if (signal.aborted) return pipelineFailure("learning_aborted", "Source nomination was cancelled");

    const jobId = toolLearningJobId(plan), canonical = planForJob(loaded.state, jobId);
    if (canonical === undefined || plan.scope !== options.scope || contentHashOf(canonical) !== contentHashOf(plan)) {
      return pipelineFailure("tool_learning_source_unavailable", jobId);
    }

    const proof = toolFundingOriginFromBoard(loaded.state, plan);
    if (!proof.ok) return proof;

    if (plan.fundingOrigin !== undefined) return pipelineFailure("tool_acquisition_review_uses_original_materializer", jobId);

    const action = toolSourceReport(plan, options.centralScope ?? options.scope);
    const existing = loaded.state.learningIssues?.find(item => item.issueId === action.issueId);
    if (existing !== undefined && (plan.researchOrigin === undefined || existing.reports.some(report => report.reportId === action.report.reportId))) return existing.scope === action.scope ? { ok: true as const, issueId: existing.issueId }
      : pipelineFailure("learning_scope_mismatch", action.issueId);

    if (plan.researchOrigin !== undefined && (existing === undefined || existing.scope !== action.scope)) return pipelineFailure("learning_scope_mismatch", action.issueId);

    const report = existing === undefined ? action : { ...action, expectedRevision: existing.revision };
    const applied = await store.apply({ type: "coordinate_learning", commandId: `tool-budget:${contentHashOf(action)}`,
      issuedAt: new Date(options.now()).toISOString(), action: report });

    return applied.ok ? { ok: true as const, issueId: action.issueId } : pipelineFailure(applied.reason, applied.detail);
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

function toolSourceReport(plan: ToolLearningPlan, scope: string): Extract<CoordinationAction, { kind: "report" }> {
  const { identity, issueId } = toolLearningFundingIdentity(plan), jobId = toolLearningJobId(plan);
  return { kind: "report", scope, issueId, problemKey: `tool:${identity}`, expectedRevision: 0,
    report: { reportId: plan.researchOrigin === undefined ? `tool-report:${identity}` : `tool-successor-report:${contentHashOf(jobId)}`, source: { subsystem: "tool", taskId: plan.trigger.runId, versionId: jobId },
      facts: ["tool_learning_opt_in", `plan:${jobId}`], evidenceRefs: plan.trigger.evidenceRefs } };
}

export function managedSourceFailure(state: BoardState, plan: ToolLearningPlan, binding: ManagedToolFundingBinding | undefined) {
  return binding?.semanticFingerprint !== undefined && toolCentralSemanticFingerprint(state, plan) !== binding.semanticFingerprint
    ? pipelineFailure("tool_managed_source_changed", "The original semantic source requires a new central decision") : undefined;
}

function budgetOf(grant: CentralLearningGrant, stage: ManagedToolFundingBinding["stage"]) {
  const remaining = stageRemaining(grant, stage), cap = stage?.allowance ?? grant.allowance;
  return { grantId: grant.grantId, maxCalls: Math.min(grant.allowance.maxCalls, cap.maxCalls), maxTokens: Math.min(grant.allowance.maxTokens, cap.maxTokens),
    callsRemaining: remaining.calls, tokensRemaining: remaining.tokens, maxPromptChars: Math.min(grant.allowance.maxPromptChars, cap.maxPromptChars) };
}

function stageRemaining(grant: CentralLearningGrant, stage: ManagedToolFundingBinding["stage"]): CentralLearningResources {
  const remaining = centralLearningRemaining(grant);

  if (stage === undefined) return remaining;

  const floor = stage.chargedAtStart, cap = stage.allowance;
  if (!Number.isSafeInteger(floor.calls) || floor.calls < 0 || floor.calls > grant.reservations.length || floor.steps !== floor.calls) {
    return { tokens: 0, calls: 0, steps: 0 };
  }

  // Reservations are append-only. A late known receipt may reduce an old
  // unknown charge, but can never refill this operation's already-spent tokens.
  const own = grant.reservations.slice(floor.calls);
  const tokens = own.reduce((sum, item) => sum + (item.usage?.kind === "reported" ? item.usage.totalTokens : item.maxTokens), 0);

  return { tokens: Math.min(remaining.tokens, Math.max(0, cap.maxTokens - tokens)),
    calls: Math.min(remaining.calls, Math.max(0, cap.maxCalls - own.length)),
    steps: Math.min(remaining.steps, Math.max(0, cap.maxSteps - own.length)) };
}
