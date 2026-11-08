import { randomUUID } from "node:crypto";
import { centralLearningRemaining, centralLearningSpent, type CentralLearningGrant, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { isCentralLearningAllowance } from "../../../../control/coordination-parse.js";
import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { contentHashOf } from "../../../../control/hash.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import type { WorkflowImprovementFunding } from "../runtime/improvement-contracts.js";
import type { WorkflowResearchBinding, WorkflowResearchFundingPort, WorkflowResearchStageBinding } from "../runtime/research-funding-contracts.js";
import { workflowAssetSelfVisibility, workflowForgottenAssetIds } from "../runtime/asset-visibility.js";
import { workflowImprovementGrantSuffix } from "../runtime/improvement-identities.js";
import { workflowSourceGrants } from "../runtime/improvement-source-grants.js";

type Options = {
  readonly scope: string; readonly centralScope: string; readonly budgetId: string; readonly now: () => number; readonly ownerId?: string;
  readonly binding?: WorkflowResearchBinding;
  readonly read: BoardStore["load"];
  readonly write: <T>(run: (store: BoardStore) => Promise<WorkflowLearningResult<T>>) => Promise<WorkflowLearningResult<T>>;
  readonly apply: (store: BoardStore, action: CoordinationAction) => Promise<WorkflowLearningResult<BoardState>>;
};

type Selected = { readonly grant: CentralLearningGrant; readonly job: BoardState["jobs"][number] };

const validStepId = (value: string) => typeof value === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value);
const stepPrefix = (grantId: string) => `workflow-research:${contentHashOf(grantId).slice(0, 20)}:`;

function stageRemaining(grant: CentralLearningGrant, stage: WorkflowResearchStageBinding | undefined) {
  const remaining = centralLearningRemaining(grant);

  if (stage === undefined) return remaining;

  // Calls identify an append-only reservation boundary. A late correction to an
  // earlier unknown charge must not replenish this operation's token allowance.
  const own = grant.reservations.slice(stage.chargedAtStart.calls);
  const tokens = own.reduce((sum, item) => sum + (item.usage?.kind === "reported" ? item.usage.totalTokens : item.maxTokens), 0);

  return { tokens: Math.min(remaining.tokens, Math.max(0, stage.allowance.maxTokens - tokens)),
    calls: Math.min(remaining.calls, Math.max(0, stage.allowance.maxCalls - own.length)),
    steps: Math.min(remaining.steps, Math.max(0, stage.allowance.maxSteps - own.length)) };
}

/** Explicit continuation follows its original source, never the next host's budget prefix.
 * Independent entrypoints cannot acquire managed grants even if their IDs look local. */
export function workflowResearchGrantBinding(state: BoardState, funding: WorkflowImprovementFunding,
  options: Pick<Options, "scope" | "centralScope" | "binding">): WorkflowLearningResult<Selected> {
  const grant = state.centralLearningGrants?.find(item => item.grantId === funding.grantId);
  const job = state.jobs.find(item => item.jobId === funding.jobId);
  const issue = state.learningIssues?.find(item => item.issueId === grant?.issueId);
  const asset = state.assets.find(item => item.versionId === funding.inputVersionId);

  if (options.binding === undefined && grant?.budgetId !== undefined) {
    return workflowFailure("workflow_managed_grant_requires_central_dispatch", "Independent research cannot consume or stop a centrally managed grant");
  }

  if (grant?.domain !== "workflow" || grant.scope !== options.centralScope || asset?.scope !== options.scope
    || !grant.grantId.endsWith(workflowImprovementGrantSuffix(funding.inputVersionId))
    || grant.jobId !== funding.jobId || job?.domain !== "workflow" || job.scope !== options.centralScope
    || issue?.scope !== options.centralScope || issue.grantId !== grant.grantId || issue.jobId !== job.jobId
    || issue.decision.kind !== "focused_learning" || grant.focusRevision !== issue.decision.revision
    || !issue.reports.some(item => "subsystem" in item.source && item.source.subsystem === "workflow" && item.source.versionId === funding.inputVersionId)
    || options.binding !== undefined && (funding.grantId !== options.binding.grantId || funding.inputVersionId !== options.binding.inputVersionId)
    || options.binding?.expectedIssueRevision !== undefined && issue.revision !== options.binding.expectedIssueRevision) {
    return workflowFailure("learning_claim_conflict", "Research must retain its exact original source, issue and grant");
  }

  const open = workflowSourceGrants(state, options.centralScope, funding.inputVersionId).filter(item => item.status === "open");
  if (grant.status === "open" && (open.length !== 1 || open[0]?.grantId !== grant.grantId)) {
    return workflowFailure("workflow_source_has_multiple_grants", "The original source must have one unambiguous open grant");
  }

  return { ok: true, value: { grant, job } };
}

/** The original writer owns claims, reservations and late usage. Research only adds
 * a stable per-step reservation address and reuses one lease across its inner loop. */
export function createWorkflowResearchFunding(options: Options): WorkflowResearchFundingPort {
  const ownerId = options.ownerId ?? `workflow-research:${randomUUID()}`;
  const select = (state: BoardState, funding: WorkflowImprovementFunding): WorkflowLearningResult<Selected> => {
    if (workflowAssetSelfVisibility(state, funding.inputVersionId) !== "available"
      || workflowForgottenAssetIds(state).has(funding.inputVersionId)) {
      return workflowFailure("workflow_improvement_source_unavailable", "The original research source was withdrawn or forgotten");
    }

    const bound = workflowResearchGrantBinding(state, funding, options);
    if (!bound.ok) return bound;

    const { grant, job } = bound.value;
    const stage = options.binding?.stage, spent = centralLearningSpent(grant);
    if (stage !== undefined && (!isCentralLearningAllowance(stage.allowance)
      || !Object.values(stage.chargedAtStart).every(value => Number.isSafeInteger(value) && value >= 0)
      || stage.chargedAtStart.calls > spent.calls || stage.chargedAtStart.steps > spent.steps)) {
      return workflowFailure("workflow_research_stage_binding_invalid", "The operation must start from its actual charged grant prefix");
    }

    if (grant.status !== "open") return workflowFailure("learning_grant_closed", grant.grantId);

    if (job.state !== "queued" && job.state !== "running") return workflowFailure("learning_claim_conflict", "Research is not at a resumable worker boundary");

    return { ok: true, value: { grant, job } };
  };
  const ensureClaim = async (store: BoardStore, funding: WorkflowImprovementFunding, selected: Selected): Promise<WorkflowLearningResult<Selected>> => {
    const { grant, job } = selected;

    if (grant.claim !== undefined && Date.parse(grant.claim.expiresAt) > options.now()) {
      return job.state === "running" && grant.claim.ownerId === ownerId ? { ok: true, value: selected }
        : workflowFailure("learning_claim_active", "Another live worker owns the research lease");
    }

    const claimId = `workflow-research-claim:${contentHashOf([funding.grantId, ownerId, job.attempt + 1])}`;
    const claimed = await options.apply(store, { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId,
      ownerId, expiresAt: new Date(options.now() + 600_000).toISOString(),
      ...(options.binding?.expectedIssueRevision === undefined ? {} : { expectedIssueRevision: options.binding.expectedIssueRevision }) });

    return claimed.ok ? select(claimed.value, funding) : claimed;
  };

  return {
    async inspect(funding) {
      const loaded = await options.read();
      if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

      const selected = select(loaded.state, funding);
      if (!selected.ok) return selected;

      const { grant, job } = selected.value, prefix = stepPrefix(grant.grantId);
      const steps = grant.reservations.filter(item => item.reservationId.startsWith(prefix));

      return { ok: true, value: { remaining: stageRemaining(grant, options.binding?.stage),
        maxPromptChars: Math.min(grant.allowance.maxPromptChars, options.binding?.stage?.allowance.maxPromptChars ?? grant.allowance.maxPromptChars),
        state: job.state === "running" ? "running" : "queued", ...(grant.claim === undefined ? {} : { activeClaim: grant.claim }),
        attemptedStepIds: steps.map(item => item.reservationId.slice(prefix.length)),
        unknownStepIds: steps.filter(item => item.state === "reserved" || item.usage?.kind !== "reported")
          .map(item => item.reservationId.slice(prefix.length)) } };
    },
    claim: funding => options.write(async store => {
      const loaded = await store.load();
      if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

      const selected = select(loaded.state, funding);
      if (!selected.ok) return selected;

      const claimed = await ensureClaim(store, funding, selected.value);
      if (!claimed.ok) return claimed;

      const claimId = claimed.value.grant.claim?.claimId;

      return claimId === undefined ? workflowFailure("learning_claim_conflict", "The Board did not retain the research claim")
        : { ok: true, value: { ...funding, claimId,
          ...(options.binding?.expectedIssueRevision === undefined ? {} : { expectedIssueRevision: options.binding.expectedIssueRevision }) } };
    }),
    reserve: (funding, input) => options.write(async store => {
      if (!validStepId(input.stepId) || input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) {
        return workflowFailure("invalid_budget", "Research requires a stable bounded step ID and positive token cap");
      }

      const loaded = await store.load();
      if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

      const selected = select(loaded.state, funding);
      if (!selected.ok) return selected;

      const reservationId = `${stepPrefix(funding.grantId)}${input.stepId}`;
      if (selected.value.grant.reservations.some(item => item.reservationId === reservationId)) {
        return workflowFailure("workflow_research_step_already_attempted", "An attempted step cannot send a second model request");
      }

      const claimed = await ensureClaim(store, funding, selected.value);
      if (!claimed.ok) return claimed;

      const grant = claimed.value.grant, remaining = stageRemaining(grant, options.binding?.stage), claimId = grant.claim?.claimId;
      if (claimId === undefined) return workflowFailure("learning_claim_conflict", "The Board did not retain the research claim");

      const maxTokens = Math.min(input.maxTokens ?? remaining.tokens, remaining.tokens);
      if (remaining.calls < 1 || remaining.steps < 1 || maxTokens < 1) return workflowFailure("learning_grant_exhausted", grant.grantId);

      const reserved = await options.apply(store, { kind: "reserve", grantId: grant.grantId, claimId, reservationId, maxTokens });

      return reserved.ok ? { ok: true, value: { ...funding, claimId, reservationId, maxTokens,
        ...(options.binding?.expectedIssueRevision === undefined ? {} : { expectedIssueRevision: options.binding.expectedIssueRevision }) } } : reserved;
    }),
  };
}
