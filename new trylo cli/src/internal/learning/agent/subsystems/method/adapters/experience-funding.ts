import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningRemaining, type CentralLearningAllowance, type CentralLearningGrant, type CoordinationAction } from "../../../../control/coordination-contract.js";
import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { ExperienceReviewRequest } from "../experience-port.js";
import type { ExperienceFundingPort } from "./experience-model.js";
import { EXPERIENCE_MODEL_LIMITS as LIMITS } from "./experience-budget.js";
import { methodFundingIdentity } from "./funding-identity.js";

export type ExperienceGrantBinding = { readonly grantId: string; readonly claimId: string;
  /** Optional stage ceiling inside the existing lifetime grant. It is never a second purse. */
  readonly envelope?: CentralLearningAllowance };

type Options = {
  readonly boardRoot: string; readonly workspaceId: string; readonly turnId: string; readonly now: () => string;
  /** Central dispatch uses the canonical workspace path; existing asset identities keep workspaceId. */
  readonly centralScope?: string;
  readonly request: ExperienceReviewRequest; readonly enabled: () => boolean; readonly binding?: ExperienceGrantBinding;
};

type Failure = { readonly ok: false; readonly reason: string };

type Funding = { readonly ok: true; readonly grant: CentralLearningGrant; readonly claimId: string };

/** Only the shared Board owns allowances, reservations and usage. The opt-in nominates a bounded method-scope issue once. */
export function createExperienceFunding(options: Options): ExperienceFundingPort {
  let bound: Funding | undefined;
  const ensure = async (): Promise<Funding | Failure> => {
    if (!options.enabled()) return failure("method_review_inactive");
    if (bound !== undefined) return bound;
    const result = await withBoardWriter(options.boardRoot, store => openFunding(store, options));
    if (!result.ok) return failure(result.reason);
    bound = result;
    return result;
  };

  return {
    async inspect() {
      const opened = await ensure();
      if (!opened.ok) return opened;

      const loaded = await createBoardReader(options.boardRoot).load();
      if (!loaded.ok) return failure(loaded.reason);

      const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === opened.grant.grantId);
      if (grant === undefined) return failure("method_review_grant_missing");

      const activeClaim = grant.claim !== undefined && Date.parse(grant.claim.expiresAt) > Date.parse(options.now());
      const remaining = centralLearningRemaining(grant), envelope = options.binding?.envelope;

      return { ok: true, active: options.enabled() && grant.status === "open" && (!activeClaim || grant.claim?.claimId === opened.claimId),
        remaining: envelope === undefined ? remaining : { tokens: Math.min(remaining.tokens, envelope.maxTokens),
          calls: Math.min(remaining.calls, envelope.maxCalls), steps: Math.min(remaining.steps, envelope.maxSteps) },
        maxPromptChars: Math.min(grant.allowance.maxPromptChars, envelope?.maxPromptChars ?? grant.allowance.maxPromptChars) };
    },
    async reserve(input) {
      const opened = await ensure();
      if (!opened.ok) return opened;

      if (input.maxTokens > LIMITS.reservationTokens) return failure("method_review_reservation_limit");

      if (options.binding?.envelope !== undefined && input.maxTokens > options.binding.envelope.maxTokens) return failure("method_review_stage_envelope");

      const result = await withBoardWriter(options.boardRoot, async store => {
        const loaded = await store.load();
        if (!loaded.ok) return failure(loaded.reason);

        const existing = loaded.state.centralLearningGrants?.find(item => item.grantId === opened.grant.grantId)?.reservations
          .find(item => item.reservationId === input.reservationId);
        if (existing !== undefined) return existing.maxTokens === input.maxTokens ? { ...opened, duplicate: true }
          : failure("learning_grant_conflict");

        const claimed = options.binding === undefined ? await claimFunding(store, options, loaded.state, opened.grant.grantId) : opened;
        if (!claimed.ok) return claimed;

        const reserved = await apply(store, options, { kind: "reserve", grantId: claimed.grant.grantId, claimId: claimed.claimId, ...input });

        return reserved.ok ? { ...claimed, duplicate: reserved.duplicate } : reserved;
      });
      if (result.ok) bound = result;

      return result.ok ? { ok: true, status: result.duplicate ? "duplicate" : "reserved" } : result;
    },
    async settle(input) {
      const opened = bound;
      if (opened === undefined) return failure("method_review_grant_missing");

      // Usage must still settle after cancellation or a disabled learning switch.
      const result = await send(options, { kind: "settle", grantId: opened.grant.grantId, ...input });
      if (!result.ok) return result;

      if (options.binding !== undefined || result.state.centralLearningGrants?.find(item =>
        item.grantId === opened.grant.grantId)?.status === "closed") return { ok: true };

      const yielded = await send(options, { kind: "finish", jobId: opened.grant.jobId, claimId: opened.claimId,
        result: { kind: "yielded", reason: "method_review_step_settled" } });

      return yielded.ok ? { ok: true } : yielded;
    },
  };
}

async function openFunding(store: BoardStore, options: Options): Promise<Funding | Failure> {
  const loaded = await store.load();
  if (!loaded.ok) return failure(loaded.reason);

  let state = loaded.state;

  if (options.binding !== undefined) return resolveBinding(state, options, options.binding);

  if (state.centralLearningBudgets?.some(item => item.scope === (options.centralScope ?? options.workspaceId))) {
    return failure("method_central_dispatch_required");
  }

  // Scope normalization cannot create another four-call lifetime purse for an
  // already funded method/range. Keep the original grant and its exact history.
  const selected = methodFundingIdentity(state.centralLearningGrants ?? [], options.workspaceId, options.centralScope ?? options.workspaceId,
    { versionId: options.request.versionId, scopeId: options.request.scope.scopeId });
  if (!selected.ok) return selected;

  const { issueId, grantId } = selected;
  let issue = state.learningIssues?.find(item => item.issueId === issueId);
  if (issue === undefined) {
    const reported = await apply(store, options, methodSourceReport(options, selected));
    if (!reported.ok) return reported;
    state = reported.state;
    issue = state.learningIssues?.find(item => item.issueId === issueId);
  }

  if (issue?.decision.kind === "unreviewed") {
    const decided = await apply(store, options, { kind: "decide", issueId, expectedRevision: issue.revision,
      decision: "focused_learning", reason: "Authorized method opt-in: bounded version/scope promotion and repair review.", sourceRefs: [options.request.snapshotId] });
    if (!decided.ok) return decided;
    state = decided.state;
    issue = decided.state.learningIssues?.find(item => item.issueId === issueId);
  }

  if (issue === undefined || issue.decision.kind !== "focused_learning") return failure("method_review_issue_unfocused");

  let grant = state.centralLearningGrants?.find(item => item.grantId === grantId);
  if (grant === undefined) {
    const funded = await apply(store, options, { kind: "fund", domain: "prompt", issueId, expectedRevision: issue.revision, grantId,
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxCalls: LIMITS.scopeCalls, maxTokens: LIMITS.scopeTokens,
        maxSteps: LIMITS.scopeSteps, maxPromptChars: LIMITS.promptChars } });
    if (!funded.ok) return funded;
    state = funded.state;
    grant = funded.state.centralLearningGrants?.find(item => item.grantId === grantId);
  }

  if (grant === undefined || grant.domain !== "prompt" || grant.status !== "open") return failure("method_review_grant_closed");

  const remaining = centralLearningRemaining(grant);
  if (remaining.calls < 1 || remaining.steps < 1 || remaining.tokens < 512) return failure("method_review_budget_exhausted");

  return { ok: true, grant, claimId: "" };
}

/** A qualified source becomes visible to PA without focusing, funding or invoking its model. */
export async function nominateMethodExperienceSource(options: Omit<Options, "binding">) {
  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return failure(loaded.reason);

    const selected = methodFundingIdentity(loaded.state.centralLearningGrants ?? [], options.workspaceId,
      options.centralScope ?? options.workspaceId, { versionId: options.request.versionId, scopeId: options.request.scope.scopeId });
    if (!selected.ok) return selected;

    const existing = loaded.state.learningIssues?.find(item => item.issueId === selected.issueId);
    if (existing !== undefined) return { ok: true as const, issueId: existing.issueId };

    const reported = await apply(store, options, methodSourceReport(options, selected));

    return reported.ok ? { ok: true as const, issueId: selected.issueId } : reported;
  });
  return result.ok ? result : failure(result.reason);
}

function methodSourceReport(options: Options, selected: Extract<ReturnType<typeof methodFundingIdentity>, { ok: true }>):
  Extract<CoordinationAction, { kind: "report" }> {
  return { kind: "report", issueId: selected.issueId, scope: selected.scope, problemKey: `method:${selected.identity}`,
    expectedRevision: 0, report: { reportId: `method-report:${selected.identity}`,
      source: { subsystem: "method", taskId: options.turnId, versionId: options.request.versionId },
      facts: ["method_opt_in", `scope:${options.request.scope.scopeId}`], evidenceRefs: [options.request.snapshotId] } };
}

async function claimFunding(store: BoardStore, options: Options, state: BoardState, grantId: string): Promise<Funding | Failure> {
  const grant = state.centralLearningGrants?.find(item => item.grantId === grantId);
  if (grant === undefined) return failure("method_review_grant_missing");

  const job = state.jobs.find(item => item.jobId === grant.jobId);
  if (job === undefined) return failure("method_review_job_missing");

  const claimId = `method-claim:${contentHashOf([grantId, options.turnId, job.attempt + 1])}`;
  const claimed = await apply(store, options, { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId,
    ownerId: `method:${options.turnId}`, expiresAt: new Date(Date.parse(options.now()) + LIMITS.claimLeaseMs).toISOString() });
  if (!claimed.ok) return claimed;

  const next = claimed.state.centralLearningGrants?.find(item => item.grantId === grantId);

  return next === undefined ? failure("method_review_grant_missing") : { ok: true, grant: next, claimId };
}

function resolveBinding(state: BoardState, options: Options, binding: ExperienceGrantBinding): Funding | Failure {
  const selected = methodFundingIdentity(state.centralLearningGrants ?? [], options.workspaceId, options.centralScope ?? options.workspaceId,
    { versionId: options.request.versionId, scopeId: options.request.scope.scopeId });
  if (!selected.ok) return selected;

  const grant = state.centralLearningGrants?.find(item => item.grantId === binding.grantId);
  const issue = state.learningIssues?.find(item => item.issueId === grant?.issueId);
  const sourceMatches = issue !== undefined && issue.reports.length > 0 && issue.reports.every(report =>
    "subsystem" in report.source && report.source.subsystem === "method" && report.source.versionId === options.request.versionId
    && report.facts.includes(`scope:${options.request.scope.scopeId}`));

  return sourceMatches && grant?.domain === "prompt" && grant.scope === selected.scope && grant.grantId === selected.grantId
    && issue?.issueId === selected.issueId && grant.jobId === issue.jobId && grant.claim?.claimId === binding.claimId
    ? { ok: true, grant, claimId: binding.claimId } : failure("method_review_grant_binding");
}

async function send(options: Options, action: CoordinationAction) {
  const result = await withBoardWriter(options.boardRoot, store => apply(store, options, action));
  return result.ok && "state" in result ? result : failure(result.ok ? "method_review_write_unknown" : result.reason);
}

async function apply(store: BoardStore, options: Options, action: CoordinationAction) {
  if (!options.enabled() && action.kind !== "settle" && action.kind !== "finish") return failure("method_review_inactive");
  const result = await store.apply({ type: "coordinate_learning", commandId: `method-budget:${contentHashOf(action)}`,
    issuedAt: options.now(), action });
  return result.ok ? { ok: true as const, state: result.state, duplicate: result.idempotent } : failure(result.reason);
}

function failure(reason: string): Failure { return { ok: false, reason }; }
