import { randomUUID } from "node:crypto";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent, type CentralLearningAllowance, type CoordinationAction } from "../../../../control/coordination-contract.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { workflowFamilyKey } from "../domain/family.js";
import { workflowProcessKey } from "../improvement/index.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { saveWorkflowImprovementRecord, workflowImprovementRecordId, type WorkflowImprovementOpportunityRecord } from "./improvement-board.js";
import { WORKFLOW_IMPROVEMENT_LIMITS, type WorkflowImprovementFunding, type WorkflowImprovementReservation } from "../runtime/improvement-contracts.js";
import { workflowImprovementGrantSuffix, workflowImprovementSourceBindingRef } from "../runtime/improvement-identities.js";
import { workflowAssetSelfVisibility, workflowForgottenAssetIds } from "../runtime/asset-visibility.js";
import { workflowSourceGrants, dispatchedWorkflowSourceGrant } from "../runtime/improvement-source-grants.js";
import { createWorkflowResearchFunding, workflowResearchGrantBinding } from "./research-funding.js";
import { workflowResearchReadiness } from "../runtime/research-readiness.js";
import { workflowImprovementsFromBoard } from "./improvement-board.js";
import type { WorkflowResearchBinding } from "../runtime/research-funding-contracts.js";

export type { WorkflowImprovementFunding, WorkflowImprovementReservation } from "../runtime/improvement-contracts.js";

/** Source readiness only; the central allocator still owns every managed funding decision. */
export type WorkflowFundingPreparation = {
  readonly issueId: string; readonly expectedIssueRevision: number; readonly grantId: string; readonly inputVersionId: string;
  readonly boardSequence: number; readonly sourceBindingRef: string; readonly allowance: CentralLearningAllowance;
  readonly existing?: WorkflowImprovementFunding;
};

/** A host-issued run allowance is allocated atomically from canonical Board grants. */
export function createWorkflowImprovementFunding(options: {
  readonly boardRoot: string; readonly scope: string; readonly centralScope?: string; readonly budgetId: string;
  readonly allowance: number; readonly now: () => number;
  /** Explicit research mode uses the same bounded grant across multiple inner-loop requests. */
  readonly research?: boolean;
  /** A live factory owns one lease; a restarted factory cannot impersonate its predecessor. */
  readonly researchOwnerId?: string;
  /** PA dispatch may consume exactly one already funded source, never this run's other grants. */
  readonly binding?: WorkflowResearchBinding;
  /** Central source preparation never reuses an already sent immutable input or silently replaces a stale focus. */
  readonly preparation?: { readonly kind: "central_source";
    /** Source preparation quotes this caller's envelope; the root still owns funding. */
    readonly allowance?: CentralLearningAllowance;
    readonly expectedIssue?: { readonly issueId: string; readonly revision: number } };
}) {
  const centralScope = options.centralScope ?? options.scope;
  const researchOwnerId = options.research === true ? options.researchOwnerId ?? `workflow-research:${randomUUID()}` : undefined;
  const prefix = `workflow-grant:${contentHashOf(options.centralScope === undefined ? options.budgetId : [centralScope, options.budgetId]).slice(0, 20)}`;
  const owns = (grantId: string) => options.binding === undefined ? grantId.startsWith(prefix) : grantId === options.binding.grantId;
  const at = () => new Date(options.now()).toISOString();
  const apply = async (store: BoardStore, action: CoordinationAction) => {
    const result = await store.apply({ type: "coordinate_learning", commandId: `workflow-coordinate:${contentHashOf(action)}`, issuedAt: at(), action });
    return result.ok ? { ok: true as const, value: result.state } : workflowFailure(result.reason, result.detail);
  };
  const write = async <T>(run: (store: BoardStore) => Promise<WorkflowLearningResult<T>>) => {
    const result = await withBoardWriter(options.boardRoot, run);
    return "reason" in result ? workflowFailure(result.reason, result.detail) : result;
  };
  const researchSource = (state: BoardState, inputVersionId: string) => {
    const history = workflowSourceGrants(state, centralScope, inputVersionId), open = history.filter(item => item.status === "open");
    if (open.length > 1) return workflowFailure("workflow_source_has_multiple_grants", "Research cannot choose between competing original grants");

    const grant = open[0];
    if (grant === undefined) {
      if (history.length === 0) return { ok: true as const, value: undefined };

      const view = workflowImprovementsFromBoard(state, options.scope, centralScope);
      if (!view.ok) return view;

      const source = view.value.opportunities.find(item => item.versionId === inputVersionId);
      const hasCheckpoint = state.assets.some(item => item.scope === options.scope && typeof item.content === "object" && item.content !== null
        && "type" in item.content && item.content.type === "workflow_improvement_research"
        && "inputVersionId" in item.content && item.content.inputVersionId === inputVersionId);
      const hasProduct = source !== undefined && view.value.versions.some(item =>
        item.artifact.opportunity.opportunityId === source.record.opportunity.opportunityId);

      // A cancelled, never-sent source retains the established explicit fresh-run
      // authorization path. Any paid/unknown attempt or research product forbids it.
      return history.some(item => item.reservations.length > 0) || hasCheckpoint || hasProduct
        ? workflowFailure("workflow_explicit_grant_required", "A sent or researched source cannot receive another independent wallet")
        : { ok: true as const, value: undefined };
    }

    const funded: WorkflowImprovementFunding = { grantId: grant.grantId, jobId: grant.jobId, inputVersionId, state: "existing",
      resultRefs: state.jobs.find(item => item.jobId === grant.jobId)?.coordination?.resultRefs ?? [] };
    const bound = workflowResearchGrantBinding(state, funded, { scope: options.scope, centralScope,
      ...(options.binding === undefined ? {} : { binding: options.binding }) });

    return bound.ok ? { ok: true as const, value: { funded, grant: bound.value.grant } } : bound;
  };
  const prepareFunding = async (store: BoardStore, record: WorkflowImprovementOpportunityRecord): Promise<WorkflowLearningResult<WorkflowFundingPreparation>> => {
    const saved = await saveWorkflowImprovementRecord(store, record, at());
    if (!saved.ok) return saved;

    const loaded = await store.load();
    if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

    let state = loaded.state;
    const inputVersionId = workflowImprovementRecordId(record);

    if (options.preparation?.kind === "central_source") {
      const expected = options.preparation.expectedIssue;
      const current = expected === undefined ? undefined : state.learningIssues?.find(item => item.issueId === expected.issueId && item.scope === centralScope);
      if (expected !== undefined && (current === undefined || current.revision !== expected.revision || current.decision.kind !== "focused_learning")) {
        return workflowFailure("learning_issue_conflict", "The original source focus changed before central preparation");
      }

      const sent = dispatchedWorkflowSourceGrant(workflowSourceGrants(state, centralScope, inputVersionId));
      if (sent !== undefined) return workflowFailure("workflow_explicit_grant_required", "An immutable input cannot be sent again through another central host run");
    }

    const grantId = `${prefix}${workflowImprovementGrantSuffix(inputVersionId)}`;
    const existing = state.centralLearningGrants?.find(item => item.grantId === grantId);
    if (existing !== undefined) return { ok: true, value: { issueId: existing.issueId,
      expectedIssueRevision: state.learningIssues?.find(item => item.issueId === existing.issueId)?.revision ?? existing.focusRevision,
      grantId, inputVersionId, boardSequence: state.sequence, sourceBindingRef: workflowImprovementSourceBindingRef(centralScope, inputVersionId),
      allowance: existing.allowance, existing: { grantId, jobId: existing.jobId, inputVersionId,
        state: "existing", resultRefs: state.jobs.find(item => item.jobId === existing.jobId)?.coordination?.resultRefs ?? [] } } };

    const runGrants = (state.centralLearningGrants ?? []).filter(item => item.scope === centralScope && item.domain === "workflow" && item.grantId.startsWith(prefix));
    const managedAllowance = options.preparation?.allowance;
    if (managedAllowance === undefined && runGrants.length >= WORKFLOW_IMPROVEMENT_LIMITS.maxRunCalls) return workflowFailure("learning_call_limit", "This run exhausted its bounded workflow proposal attempts");

    const committedCalls = runGrants.reduce((sum, item) => sum + (item.status === "open" ? item.allowance.maxCalls : centralLearningSpent(item).calls), 0);
    const remainingCalls = managedAllowance?.maxCalls ?? Math.max(0, WORKFLOW_IMPROVEMENT_LIMITS.maxRunCalls - committedCalls);
    if (remainingCalls < 1) return workflowFailure("learning_call_limit", "This run's original workflow calls are allocated or consumed");

    const allocated = runGrants.reduce((sum, item) => sum + (item.status === "open" ? item.allowance.maxTokens : centralLearningSpent(item).tokens), 0);
    const remaining = managedAllowance?.maxTokens ?? Math.max(0, options.allowance - allocated);
    if (!Number.isSafeInteger(remaining) || remaining < 1024) return workflowFailure("learning_budget_exhausted", "The run's central workflow allowance is already allocated or consumed");

    const opportunity = record.opportunity;
    const issueHash = contentHashOf([centralScope, opportunity.task.process === undefined ? workflowFamilyKey(opportunity.task.taskFamily)
      : workflowProcessKey(opportunity.task.process), opportunity.issueKey]);
    const issueId = `workflow-issue:${issueHash}`;
    let issue = state.learningIssues?.find(item => item.issueId === issueId);
    const reportId = `workflow-report:${contentHashOf(inputVersionId)}`;
    if (!issue?.reports.some(item => item.reportId === reportId)) {
      const reported = await apply(store, { kind: "report", scope: centralScope, issueId, problemKey: `workflow:${issueHash}`,
        expectedRevision: issue?.revision ?? 0, report: { reportId,
          source: { subsystem: "workflow", taskId: options.budgetId, versionId: inputVersionId },
          facts: [opportunity.problem.slice(0, 1000), `trigger:${opportunity.trigger}`], evidenceRefs: opportunity.evidenceRefs } });
      if (!reported.ok) return reported;
      state = reported.value;
      issue = state.learningIssues?.find(item => item.issueId === issueId);
    }

    if (issue === undefined) return workflowFailure("learning_issue_not_found", "Workflow report did not create its issue");

    const previousGrant = state.centralLearningGrants?.find(item => item.grantId === issue!.grantId);
    if (previousGrant?.status === "open") return workflowFailure("workflow_issue_busy", "An existing central grant owns this learning issue");

    // A prepare-only handoff is repeatable; a previously funded/closed issue still gets the original new-focus transition.
    if (issue.grantId !== undefined || issue.decision.kind !== "focused_learning" || !issue.decision.sourceRefs.includes(inputVersionId)) {
      const decided = await apply(store, { kind: "decide", issueId, expectedRevision: issue.revision, decision: "focused_learning",
        reason: "Explicit workflow learning opt-in permits one bounded proposal for grounded model-reported inefficiency; production continues.",
        sourceRefs: [inputVersionId, ...opportunity.evidenceRefs].slice(0, 32) });
      if (!decided.ok) return decided;
      state = decided.value;
      issue = state.learningIssues?.find(item => item.issueId === issueId);
    }

    if (issue === undefined) return workflowFailure("learning_issue_not_found", "Workflow issue disappeared before funding");

    return { ok: true, value: { issueId, expectedIssueRevision: issue.revision, grantId, inputVersionId, boardSequence: state.sequence,
      sourceBindingRef: workflowImprovementSourceBindingRef(centralScope, inputVersionId), allowance: {
        schemaVersion: 2, unit: "total_model_tokens", maxTokens: remaining,
        maxCalls: options.research === true ? remainingCalls : 1,
        maxSteps: options.research === true ? remainingCalls : 1,
        maxPromptChars: managedAllowance?.maxPromptChars ?? WORKFLOW_IMPROVEMENT_LIMITS.maxPromptChars } } };
  };

  return {
    ...(options.research === true ? { research: createWorkflowResearchFunding({ scope: options.scope, centralScope, budgetId: options.budgetId,
      now: options.now, read: () => createBoardReader(options.boardRoot).load(), write, apply,
      ...(researchOwnerId === undefined ? {} : { ownerId: researchOwnerId }),
      ...(options.binding === undefined ? {} : { binding: options.binding }) }) } : {}),
    /** Persists the canonical source/issue without issuing a grant or taking a claim. */
    async prepare(record: WorkflowImprovementOpportunityRecord): Promise<WorkflowLearningResult<WorkflowFundingPreparation>> {
      if (options.binding !== undefined) return workflowFailure("workflow_bound_grant_cannot_fund", "A focused dispatcher consumes its explicit grant only");
      return write(store => prepareFunding(store, record));
    },
    async prepareResume(inputVersionId: string) {
      return write(async store => {
        const loaded = await store.load();
        if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

        if (options.research === true) {
          const source = researchSource(loaded.state, inputVersionId);
          if (!source.ok) return source;

          if (source.value !== undefined) {
            const view = workflowImprovementsFromBoard(loaded.state, options.scope, centralScope);
            if (!view.ok) return view;
            const readiness = workflowResearchReadiness(view.value, inputVersionId, source.value.grant, options.now());
            return readiness.status === "ready" ? { ok: true as const, value: null }
              : workflowFailure(readiness.reason, "The original research source is not at a confirmed resumable boundary");
          }
        }

        const grants = workflowSourceGrants(loaded.state, centralScope, inputVersionId);
        if (grants.some(item => item.reservations.length > 0)) return workflowFailure("workflow_explicit_grant_required", "This opportunity already reserved a request; use new observations or an explicit operator fresh grant");

        for (const grant of grants.filter(item => item.status === "open")) {
          if (grant.grantId.startsWith(prefix)) continue;

          const job = loaded.state.jobs.find(item => item.jobId === grant.jobId);
          const issue = loaded.state.learningIssues?.find(item => item.issueId === grant.issueId);
          if (job?.state !== "queued" || issue?.grantId !== grant.grantId) return workflowFailure("workflow_issue_busy", "Only an unclaimed, unsent opportunity may be resumed automatically");

          const closed = await apply(store, { kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "ordinary_execution",
            reason: "Unclaimed workflow opportunity transfers to a newly authorized run allowance without sending the old request.", sourceRefs: [inputVersionId] });
          if (!closed.ok) return closed;
        }

        return { ok: true as const, value: null };
      });
    },
    /** Host cancellation also covers the window before a worker obtains its claim. */
    async stop(funding: WorkflowImprovementFunding) {
      return write(async store => {
        let loaded = await store.load();
        if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

        let grant = loaded.state.centralLearningGrants?.find(item => item.grantId === funding.grantId);

        if (options.research === true) {
          const bound = workflowResearchGrantBinding(loaded.state, funding, { scope: options.scope, centralScope,
            ...(options.binding === undefined ? {} : { binding: options.binding }) });
          if (!bound.ok) return bound;

          grant = bound.value.grant;

          if (grant.claim !== undefined && Date.parse(grant.claim.expiresAt) > options.now() && grant.claim.ownerId !== researchOwnerId) {
            return workflowFailure("learning_claim_active", "A different live researcher retains this original grant");
          }
        } else if (grant === undefined || grant.domain !== "workflow" || grant.scope !== centralScope || !owns(grant.grantId)) {
          return workflowFailure("learning_grant_not_found", "The cancelled worker does not own this grant");
        }

        if (grant === undefined) return workflowFailure("learning_grant_not_found", funding.grantId);

        for (const reservation of grant.reservations.filter(item => item.state === "reserved")) {
          const settled = await apply(store, { kind: "settle", grantId: grant.grantId, reservationId: reservation.reservationId,
            usage: { kind: "unknown", reason: "workflow_run_closed_before_settlement" } });
          if (!settled.ok) return settled;
        }

        loaded = await store.load();

        if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

        grant = loaded.state.centralLearningGrants?.find(item => item.grantId === funding.grantId);
        const issue = loaded.state.learningIssues?.find(item => item.issueId === grant?.issueId);
        const job = loaded.state.jobs.find(item => item.jobId === funding.jobId);
        if (grant?.status === "closed" || job !== undefined && ["succeeded", "failed", "cancelled", "expired"].includes(job.state)) return { ok: true as const, value: loaded.state };

        if (issue === undefined || issue.grantId !== funding.grantId) return workflowFailure("learning_claim_conflict", "A different grant now owns this issue");

        return apply(store, { kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "ordinary_execution",
          reason: "Workflow research was cancelled at the business run boundary; unresolved model usage remains reserved.", sourceRefs: [funding.inputVersionId] });
      });
    },
    async fund(record: WorkflowImprovementOpportunityRecord): Promise<WorkflowLearningResult<WorkflowImprovementFunding>> {
      if (options.binding !== undefined) return workflowFailure("workflow_bound_grant_cannot_fund", "A focused dispatcher consumes its explicit grant only");
      return write<WorkflowImprovementFunding>(async store => {
        if (options.research === true) {
          const loaded = await store.load();
          if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);
          const source = researchSource(loaded.state, workflowImprovementRecordId(record));
          if (!source.ok) return source;
          if (source.value !== undefined) return { ok: true, value: source.value.funded };
        }

        const prepared = await prepareFunding(store, record);
        if (!prepared.ok) return prepared;

        if (prepared.value.existing !== undefined) return { ok: true, value: prepared.value.existing };

        const { issueId, expectedIssueRevision, grantId, inputVersionId, allowance } = prepared.value;
        const funded = await apply(store, { kind: "fund", domain: "workflow", issueId, expectedRevision: expectedIssueRevision, grantId, allowance });
        if (!funded.ok) return funded;

        const grant = funded.value.centralLearningGrants?.find(item => item.grantId === grantId);

        return grant === undefined ? workflowFailure("learning_grant_not_found", "Workflow allowance was not committed")
          : { ok: true, value: { grantId, jobId: grant.jobId, inputVersionId, state: "queued", resultRefs: [] } };
      });
    },
    async reserve(funding: WorkflowImprovementFunding): Promise<WorkflowLearningResult<WorkflowImprovementReservation>> {
      return write(async store => {
        const loaded = await store.load();
        if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

        if (workflowAssetSelfVisibility(loaded.state, funding.inputVersionId) !== "available"
          || workflowForgottenAssetIds(loaded.state).has(funding.inputVersionId)) {
          return workflowFailure("workflow_improvement_source_unavailable", "A withdrawn or forgotten research input cannot reserve a provider request");
        }

        const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === funding.grantId);
        const job = loaded.state.jobs.find(item => item.jobId === funding.jobId);
        const issue = loaded.state.learningIssues?.find(item => item.issueId === grant?.issueId);

        if (options.research === true) {
          const bound = workflowResearchGrantBinding(loaded.state, funding, { scope: options.scope, centralScope,
            ...(options.binding === undefined ? {} : { binding: options.binding }) });
          if (!bound.ok) return bound;
        }

        if (grant?.domain !== "workflow" || grant.scope !== centralScope || options.research !== true && !owns(grant.grantId)
          || options.binding !== undefined && funding.inputVersionId !== options.binding.inputVersionId
          || options.binding?.expectedIssueRevision !== undefined && issue?.revision !== options.binding.expectedIssueRevision
          || grant.status !== "open" || job?.state !== "queued" || job.attempt !== 0) {
          return workflowFailure("learning_claim_conflict", "Only a fresh queued workflow grant may send its one model request");
        }

        const claimId = `workflow-claim:${contentHashOf([funding.grantId, options.budgetId])}`;
        const claimed = await apply(store, { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId,
          ownerId: `workflow:${contentHashOf(options.budgetId).slice(0, 32)}`, expiresAt: new Date(options.now() + 180_000).toISOString() });
        if (!claimed.ok) return claimed;

        const reservationId = `workflow-reservation:${contentHashOf([funding.grantId, claimId])}`;
        const reserved = await apply(store, { kind: "reserve", grantId: grant.grantId, claimId, reservationId, maxTokens: grant.allowance.maxTokens });

        return reserved.ok ? { ok: true, value: { ...funding, claimId, reservationId, maxTokens: grant.allowance.maxTokens,
          ...(options.binding?.expectedIssueRevision === undefined ? {} : { expectedIssueRevision: options.binding.expectedIssueRevision }) } } : reserved;
      });
    },
    async settle(reservation: WorkflowImprovementReservation, usage: Extract<CoordinationAction, { readonly kind: "settle" }>["usage"]) {
      return write(store => apply(store, { kind: "settle", grantId: reservation.grantId, reservationId: reservation.reservationId, usage }));
    },
    async finish(reservation: WorkflowImprovementReservation, result: Extract<CoordinationAction, { readonly kind: "finish" }>["result"]) {
      const expectedIssueRevision = options.binding?.expectedIssueRevision ?? reservation.expectedIssueRevision;
      return write(async store => {
        const current = await store.load();
        if (!current.ok) return workflowFailure(current.reason, current.detail);
        const bound = workflowResearchGrantBinding(current.state, reservation, { scope: options.scope, centralScope,
          ...(options.binding === undefined ? {} : { binding: options.binding }) });
        if (!bound.ok) return bound;
        return apply(store, { kind: "finish", jobId: reservation.jobId, claimId: reservation.claimId, result,
          ...(expectedIssueRevision === undefined ? {} : { expectedIssueRevision }) });
      });
    },
  };
}
