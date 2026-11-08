import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningRemaining, type CoordinationAction, type CentralLearningGrant, type LearningIssue } from "../../../../control/coordination-contract.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import { coordinationScopeValid, isCentralLearningAllowance, isCentralLearningFinishResult } from "../../../../control/coordination-parse.js";
import type { BoardState } from "../../../../control/state.js";
import { isCentralLearningSourceContext, type CentralLearningSourceContext } from "../../../../control/source-context.js";
import { systemTimerScheduler, type TimerHandle } from "../../../../../subagent/scheduler.js";
import { collaborationTimingFor, COLLABORATION_WORK_TIMEOUT } from "./timing.js";
import type { CollaborationControlOptions, CollaborationDispatchResult, ControlResult, CentralFundingPort,
  DecideLearningIssueInput, FundLearningIssueInput, ObserveLearningDependencyInput, ReportLearningIssueInput } from "./contracts.js";
import { readCollaborationNoChange } from "../orchestration/no-change-receipt.js";
import { collaborationPlanSourcesValid, isCollaborationPlan } from "../orchestration/parse.js";
import { isCollaborationExperienceContent } from "../experience/parse.js";
import { collaborationQueryMatchesReservation, collaborationResourceResultMatches } from "../../../../control/collaboration-resource-relation.js";
import type { ResumeIncompleteCollaborationInput } from "../../../../control/collaboration-failure-continuation-contract.js";
import { readCollaborationFailureContinuations } from "../../../../control/collaboration-failure-continuation.js";
import type { CollaborationResourceReceipt } from "../../../../../protocol/collaboration-resource.js";
import type { CentralLearningWorkResult } from "../../../../control/coordination-contract.js";
import { createCollaborationOperationFunding } from "./operation-funding.js";
import type { CentralLearningAllowance } from "../../../../control/coordination-contract.js";

const failure = (reason: string) => ({ ok: false as const, reason });
const enabled = (options: CollaborationControlOptions) => options.enabled?.() !== false;

type RecoveryInput = { readonly scope: string; readonly issueId: string; readonly grantId: string;
  readonly expectedIssueRevision?: number; readonly signal?: AbortSignal };

type Recovery = ControlResult<{ readonly status: "busy" | "resumable" | "recovered" | "inspection";
  readonly reason: string; readonly sourceRefs: readonly string[]; readonly result?: CentralLearningWorkResult }>;

/** A paid decision is resumable only when its actual action is confirmed. Known
 * token usage alone cannot reconstruct a lost response or a resource side effect. */
export function collaborationRecoveryEvidence(state: BoardState, current: NonNullable<ReturnType<typeof coordinationForJob>>) {
  const { issue, job, grant } = current;
  const resource = (state.collaborationRuntimeReceipts ?? []).filter((item): item is CollaborationResourceReceipt =>
    (item.phase === "resource_query" || item.phase === "resource_result") && item.scope === grant.scope
      && item.issueId === issue.issueId && item.jobId === job.jobId && item.grantId === grant.grantId);
  const queries = resource.filter(item => item.phase === "resource_query"), results = resource.filter(item => item.phase === "resource_result");
  const pairs = queries.flatMap(query => { const result = results.find(item => collaborationResourceResultMatches(query, item));
    return result === undefined ? [] : [{ query, result }]; });
  const known = new Set(issue.reports.flatMap(item => [item.reportId, ...item.evidenceRefs]));

  for (const pair of pairs) {
    known.add(pair.result.receiptId);
    for (const ref of pair.result.resultRefs) known.add(ref);
  }

  for (const dependency of state.learningDependencies ?? []) if (dependency.grantId === grant.grantId && dependency.state.kind === "ready") {
    known.add(dependency.dependencyId);
    known.add(dependency.state.resultRef);
  }

  const claims = new Set([...(grant.claim === undefined ? [] : [grant.claim.claimId]), ...grant.reservations.map(item => item.claimId)]);
  const noChanges = (state.rewardV2Facts ?? []).flatMap(fact => {
    const receipt = readCollaborationNoChange(state, grant.scope, fact.id);
    return receipt?.issueId === issue.issueId && receipt.jobId === job.jobId && receipt.grantId === grant.grantId
      && claims.has(receipt.claimId) && receipt.sourceRefs.every(ref => known.has(ref)) ? [{ ref: fact.id, sequence: fact.sequence }] : [];
  });
  const available = (versionId: string) => !state.tombstones.some(item => item.entityId === versionId
    || item.entityId === state.assets.find(asset => asset.versionId === versionId)?.createdFromProposalId);
  const plans = state.assets.flatMap(asset => {
    const plan = asset.content;
    if (asset.scope !== grant.scope || !isCollaborationPlan(plan) || plan.issueId !== issue.issueId
      || plan.focusRevision !== grant.focusRevision || !available(asset.versionId) || contentHashOf(plan) !== asset.contentHash
      || !collaborationPlanSourcesValid(state, grant.scope, plan)
      || !state.proposals.some(item => item.proposalId === asset.createdFromProposalId && item.domain === "collaboration"
        && item.scope === grant.scope && item.candidateRef === asset.versionId
        && !["rejected", "retired", "suspended", "rolled_back"].includes(item.lifecycle))
      || !plan.experienceVersionIds.every(id => state.assets.some(item => item.versionId === id && available(id)
        && item.scope === grant.scope && isCollaborationExperienceContent(item.content)
        && item.content.issueId === issue.issueId && item.content.focusRevision === grant.focusRevision
        && contentHashOf(item.content) === item.contentHash))) return [];

    const committed = state.appliedCommands.find(item => item.commandId === `${asset.versionId}:commit`);

    return committed === undefined ? [] : [{ versionId: asset.versionId, plan, sequence: committed.sequence }];
  });
  const sourceRefs = [grant.grantId, job.jobId, ...grant.reservations.map(item => item.reservationId)].slice(0, 32);
  const latestNoChange = noChanges.sort((a, b) => b.sequence - a.sequence)[0];
  const latestPlan = plans.sort((a, b) => b.sequence - a.sequence)[0];
  const outputSequence = Math.max(latestNoChange?.sequence ?? 0, latestPlan?.sequence ?? 0);
  const afterOutput = grant.reservations.filter(reservation => {
    const action = { kind: "reserve" as const, grantId: grant.grantId, claimId: reservation.claimId,
      reservationId: reservation.reservationId, maxTokens: reservation.maxTokens };
    const command = state.appliedCommands.find(item => item.commandId === `central-learning:${contentHashOf(action)}`);
    return command === undefined || command.sequence > outputSequence;
  });
  const confirmed = afterOutput.every(reservation => {
    return pairs.some(({ query }) => collaborationQueryMatchesReservation(query, reservation))
      || readCollaborationFailureContinuations(state, grant, issue.revision).some(continuation => continuation.failedReservationId === reservation.reservationId
        && reservation.usage?.kind === "unknown"
        && continuation.failureReason === reservation.usage.reason
        && state.appliedCommands.some(command => command.commandId === continuation.commandId && command.sequence === continuation.sequence)) === true;
  });
  if (pairs.length !== queries.length || pairs.length !== results.length || !confirmed) return {
    kind: "inspection" as const, reason: "collaboration_recovery_sent_step_requires_inspection", sourceRefs };

  if (afterOutput.length > 0 && outputSequence > 0) return { kind: "resume" as const,
    reason: "collaboration_recovery_confirmed_query_after_output", sourceRefs };

  if (latestNoChange !== undefined && latestNoChange.sequence === outputSequence) return { kind: "result" as const,
    result: { kind: "completed" as const, resultRefs: [latestNoChange.ref] }, sourceRefs };

  if (latestPlan !== undefined && latestPlan.sequence === outputSequence) {
    const { versionId, plan } = latestPlan;
    const dependencyIds = plan.needs.map((_need, index) => `collaboration-dependency:${contentHashOf([job.jobId, versionId, index])}`);
    const returned = dependencyIds.length > 0 && dependencyIds.every(id => state.learningDependencies?.some(item => item.dependencyId === id
      && item.grantId === grant.grantId && (item.state.kind === "ready" || item.state.kind === "authorized")));
    if (returned) return { kind: "resume" as const, reason: "collaboration_recovery_confirmed_dependency_return", sourceRefs,
      planVersionId: versionId, dependencyIds };

    const result: CentralLearningWorkResult = plan.needs.length === 0 ? { kind: "completed", resultRefs: [versionId, ...plan.experienceVersionIds] }
      : { kind: "waiting_dependency", dependencies: plan.needs.map((need, index) => {
        const dependencyId = `collaboration-dependency:${contentHashOf([job.jobId, versionId, index])}`;
        const previous = state.learningDependencies?.find(item => item.dependencyId === dependencyId);
        return previous === undefined ? { dependencyId, owner: need.owner, correlationRef: `${versionId}#need:${index}`,
          state: { kind: "waiting" as const, reason: "personal_agent_creation_consent_required" } }
          : { dependencyId: previous.dependencyId, owner: previous.owner, correlationRef: previous.correlationRef, state: previous.state,
            ...(previous.requestId === undefined ? {} : { requestId: previous.requestId }) };
      }) };

    return { kind: "result" as const, result, sourceRefs: [...sourceRefs, versionId].slice(0, 32) };
  }

  const partial = state.assets.some(asset => asset.scope === grant.scope && isCollaborationExperienceContent(asset.content)
    && asset.content.issueId === issue.issueId && asset.content.focusRevision === grant.focusRevision);

  return partial
    ? { kind: "inspection" as const, reason: "collaboration_recovery_sent_step_requires_inspection", sourceRefs }
    : { kind: "resume" as const, reason: "collaboration_recovery_confirmed_boundary", sourceRefs };
}

/** Central Board application facade; it schedules learning, never business work or permission. */
export function createCollaborationControl(options: CollaborationControlOptions) {
  const running = new Map<string, { readonly issueId: string; readonly controller: AbortController }>();
  const send = async (action: CoordinationAction, terminalAccounting = false, signal?: AbortSignal): Promise<ControlResult<{ state: BoardState; duplicate: boolean }>> => {
    if (signal?.aborted) return failure("learning_aborted");

    if (!terminalAccounting && !enabled(options)) return failure("collect_disabled");

    try {
      const applied = await options.board.apply({ type: "coordinate_learning", commandId: `central-learning:${contentHashOf(action)}`,
        issuedAt: options.now(), action }, signal);
      if (!applied.ok) return failure(signal?.aborted && applied.reason === "collect_disabled" ? "learning_aborted" : applied.reason);
      return { ok: true, state: applied.state, duplicate: applied.idempotent };
    } catch { return failure("board_unavailable"); }
  };
  const load = async (): Promise<ControlResult<{ state: BoardState }>> => {
    if (!enabled(options)) return failure("collect_disabled");
    try { const result = await options.board.load();
    if (!enabled(options)) return failure("collect_disabled");
      return result.ok ? { ok: true, state: result.state } : failure(result.reason);
    } catch { return failure("board_unavailable"); }
  };
  const funding = (grantId: string, claimId: string): CentralFundingPort => ({
    async reserve(input) {
      const result = await send({ kind: "reserve", grantId, claimId, ...input });
      if (!result.ok) return result;

      if (!enabled(options)) return failure("collect_disabled");

      const grant = result.state.centralLearningGrants?.find(g => g.grantId === grantId);
      if (grant === undefined) return failure("learning_grant_not_found");

      if (grant.status !== "open") return failure("learning_grant_closed");

      return { ok: true, status: result.duplicate ? "duplicate" : "reserved", grant, remaining: centralLearningRemaining(grant) };
    },
    async settle(input) {
      const result = await send({ kind: "settle", grantId, ...input }, true);
      if (!result.ok) return result;
      const grant = result.state.centralLearningGrants?.find(g => g.grantId === grantId);
      return grant === undefined ? failure("learning_grant_not_found") : { ok: true,
        status: result.duplicate ? "duplicate" : "settled", grant, remaining: centralLearningRemaining(grant) };
    },
    async inspect() {
      const result = await load();
      if (!result.ok) return result;

      const grant = result.state.centralLearningGrants?.find(g => g.grantId === grantId);
      if (grant === undefined) return failure("learning_grant_not_found");

      const current = coordinationForJob(result.state, grant.jobId);

      return { ok: true, grant, remaining: centralLearningRemaining(grant), active: grant.status === "open"
        && current?.issue.decision.kind === "focused_learning" && current.job.state === "running" && grant.claim?.claimId === claimId
        && Date.parse(grant.claim.expiresAt) > Date.parse(options.now()) };
    },
  });
  const recoverExpired = async (input: RecoveryInput): Promise<Recovery> => {
    if (!coordinationScopeValid(input.scope) || input.signal?.aborted) return failure("learning_aborted");

    const loaded = await load();
    if (!loaded.ok) return loaded;

    const selected = loaded.state.centralLearningGrants?.find(item => item.grantId === input.grantId);
    let current = selected === undefined ? undefined : coordinationForJob(loaded.state, selected.jobId);
    if (current === undefined || current.grant.scope !== input.scope || current.issue.issueId !== input.issueId
      || current.job.domain !== "collaboration" || current.issue.grantId !== input.grantId
      || current.issue.decision.kind !== "focused_learning" || current.grant.focusRevision !== current.issue.decision.revision
      || current.grant.status !== "open" || input.expectedIssueRevision !== undefined && current.issue.revision !== input.expectedIssueRevision) {
      return failure("collaboration_recovery_source_changed");
    }

    if (running.has(current.job.jobId) || current.grant.claim !== undefined && Date.parse(current.grant.claim.expiresAt) > Date.parse(options.now())) {
      return { ok: true, status: "busy", reason: "collaboration_recovery_live_owner", sourceRefs: [input.grantId] };
    }

    if (current.job.state !== "running" && current.job.state !== "queued") return failure("collaboration_recovery_boundary_unavailable");

    if (current.job.state === "running") {
      if (input.signal?.aborted) return failure("learning_aborted");

      const claimed = await send({ kind: "claim", jobId: current.job.jobId, expectedAttempt: current.job.attempt,
        expectedIssueRevision: current.issue.revision, ownerId: options.ownerId,
        claimId: `collaboration-recovery:${contentHashOf([current.job.jobId, current.job.attempt + 1, options.ownerId])}`,
        expiresAt: new Date(Date.parse(options.now()) + 600000).toISOString() });
      if (!claimed.ok) return claimed;

      current = coordinationForJob(claimed.state, current.job.jobId);

      if (current === undefined) return failure("learning_grant_not_found");
    }

    const latest = await load();
    if (!latest.ok) return latest;

    const checked = coordinationForJob(latest.state, current.job.jobId);
    if (checked === undefined || checked.issue.grantId !== input.grantId || checked.issue.decision.kind !== "focused_learning"
      || checked.grant.focusRevision !== checked.issue.decision.revision || checked.grant.status !== "open"
      || checked.grant.claim?.claimId !== current.grant.claim?.claimId) return failure("collaboration_recovery_source_changed");

    current = checked;
    const evidence = collaborationRecoveryEvidence(latest.state, current);
    if (evidence.kind === "resume" && current.job.state === "queued") return { ok: true, status: "resumable",
      reason: evidence.reason, sourceRefs: evidence.sourceRefs };

    if (current.job.state === "queued" && evidence.kind === "inspection") return { ok: true, status: "inspection",
      reason: evidence.reason, sourceRefs: evidence.sourceRefs };

    // Local result recovery needs ownership too; it never buys another decision.
    if (current.job.state === "queued") {
      const claimed = await send({ kind: "claim", jobId: current.job.jobId, expectedAttempt: current.job.attempt,
        expectedIssueRevision: current.issue.revision, ownerId: options.ownerId,
        claimId: `collaboration-recovery:${contentHashOf([current.job.jobId, current.job.attempt + 1, options.ownerId])}`,
        expiresAt: new Date(Date.parse(options.now()) + 600000).toISOString() });
      if (!claimed.ok) return claimed;
      current = coordinationForJob(claimed.state, current.job.jobId);
      if (current === undefined) return failure("learning_grant_not_found");
    }

    if (input.signal?.aborted) return failure("learning_aborted");

    const result = evidence.kind === "result" ? evidence.result : { kind: "yielded" as const, reason: evidence.reason };

    if (current.grant.claim === undefined) return failure("learning_claim_conflict");

    const finished = await send({ kind: "finish", jobId: current.job.jobId, claimId: current.grant.claim.claimId,
      expectedIssueRevision: current.issue.revision, result });

    return !finished.ok ? finished : evidence.kind === "result" ? { ok: true, status: "recovered", reason: "collaboration_recovery_original_result",
      sourceRefs: evidence.sourceRefs, result: evidence.result } : { ok: true, status: evidence.kind === "resume" ? "resumable" : "inspection",
        reason: evidence.reason, sourceRefs: evidence.sourceRefs };
  };
  const dispatch = async (input: { readonly scope: string; readonly issueId?: string; readonly grantId?: string;
    readonly expectedIssueRevision?: number; readonly centralSourceContext?: CentralLearningSourceContext;
    readonly operationAllowance?: CentralLearningAllowance;
    readonly signal?: AbortSignal }): Promise<CollaborationDispatchResult> => {
    if (!coordinationScopeValid(input?.scope)) return failure("invalid_learning_coordination");

    if (input.issueId !== undefined && (typeof input.issueId !== "string" || !input.issueId.trim() || input.issueId.length > 512)) {
      return failure("invalid_learning_coordination");
    }

    if (input.grantId !== undefined && (typeof input.grantId !== "string" || !input.grantId.trim() || input.grantId.length > 512)
      || input.expectedIssueRevision !== undefined && (!Number.isSafeInteger(input.expectedIssueRevision) || input.expectedIssueRevision < 1)) {
      return failure("invalid_learning_coordination");
    }

    if (input.centralSourceContext !== undefined && !isCentralLearningSourceContext(input.centralSourceContext)) {
      return failure("invalid_learning_source_context");
    }

    if (input.operationAllowance !== undefined && !isCentralLearningAllowance(input.operationAllowance)) return failure("central_stage_operation_invalid");

    const centralSourceContext = input.centralSourceContext === undefined ? undefined : Object.freeze({ ...input.centralSourceContext });

    if (!options.worker) return failure("learning_worker_unavailable");

    if (!options.ownerId || options.ownerId.length > 200) return failure("claim_owner_required");

    if (input.signal?.aborted) return failure("learning_aborted");

    const loaded = await load();
    if (!loaded.ok) return loaded;

    if (input.signal?.aborted) return failure("learning_aborted");

    const ready = loaded.state.jobs.filter(j => j.domain === "collaboration" && j.scope === input.scope && j.coordination !== undefined)
      .flatMap(j => {
        const value = coordinationForJob(loaded.state, j.jobId);
        return value === undefined ? [] : [value];
      })
      .filter(c => c.issue.decision.kind === "focused_learning" && c.grant.status === "open"
        && (input.issueId === undefined || c.issue.issueId === input.issueId)
        && (input.grantId === undefined || c.grant.grantId === input.grantId));
    const current = ready.find(c => c.job.state === "running" && (c.grant.claim === undefined || Date.parse(c.grant.claim.expiresAt) <= Date.parse(options.now())))
      ?? ready.find(c => c.job.state === "queued");
    if (current === undefined) return { ok: true, status: ready.some(c => c.job.state === "running") ? "busy"
      : ready.some(c => c.job.state === "waiting_evidence") ? "waiting_dependency" : "idle" };

    if (running.has(current.job.jobId)) return { ok: true, status: "busy", jobId: current.job.jobId };

    const needsRecovery = current.job.state === "running" || current.grant.claim !== undefined || current.grant.reservations.some(item =>
      item.state === "reserved" || item.usage?.kind !== "reported" || item.reservationId.startsWith("collaboration-decision:"));
    if (needsRecovery) {
      const recovered = await recoverExpired({ scope: input.scope, issueId: current.issue.issueId, grantId: current.grant.grantId,
      ...(input.expectedIssueRevision === undefined ? {} : { expectedIssueRevision: input.expectedIssueRevision }),
      ...(input.signal === undefined ? {} : { signal: input.signal }) });
      if (!recovered.ok) return recovered;

      if (recovered.status === "inspection") return failure(recovered.reason);

      if (recovered.status === "busy") return { ok: true, status: "busy", jobId: current.job.jobId };

      if (recovered.status === "recovered" && recovered.result !== undefined) return { ok: true, status: recovered.result.kind,
        issueId: current.issue.issueId, jobId: current.job.jobId, grantId: current.grant.grantId, result: recovered.result };

      if (current.job.state === "running") return dispatch(input);
    }

    const available = centralLearningRemaining(current.grant), requested = input.operationAllowance ?? current.grant.allowance;
    const operation = { ...requested, maxTokens: Math.min(requested.maxTokens, available.tokens),
      maxCalls: Math.min(64, requested.maxCalls, available.calls), maxSteps: Math.min(64, requested.maxSteps, available.steps),
      maxPromptChars: Math.min(requested.maxPromptChars, current.grant.allowance.maxPromptChars) };
    const timing = collaborationTimingFor(operation.maxCalls);
    const leaseMs = Math.min(options.claimLeaseMs ?? timing.leaseMs, 600000), startedAt = Date.parse(options.now());
    const controller = new AbortController(), abortFromCaller = () => controller.abort(input.signal?.reason);
    const abortReason = () => controller.signal.reason === COLLABORATION_WORK_TIMEOUT ? COLLABORATION_WORK_TIMEOUT : "learning_aborted";
    let workTimer: TimerHandle | undefined;

    input.signal?.addEventListener("abort", abortFromCaller, { once: true });

    if (input.signal?.aborted) abortFromCaller();

    running.set(current.job.jobId, { issueId: current.issue.issueId, controller });

    try {
      const claimId = `central-claim:${contentHashOf([current.job.jobId, current.job.attempt + 1, options.ownerId])}`;
      const claimed = await send({ kind: "claim", jobId: current.job.jobId, expectedAttempt: current.job.attempt, claimId, ownerId: options.ownerId,
        ...(input.expectedIssueRevision === undefined ? {} : { expectedIssueRevision: input.expectedIssueRevision }),
        expiresAt: new Date(startedAt + leaseMs).toISOString() });
      if (!claimed.ok) return claimed;

      if (claimed.duplicate) return { ok: true, status: "busy", jobId: current.job.jobId };

      const funded = coordinationForJob(claimed.state, current.job.jobId);
      if (funded === undefined) return failure("learning_grant_not_found");

      const remainingWorkMs = Math.max(0, Math.min(timing.workMs, startedAt + Math.min(timing.workMs, leaseMs) - Date.parse(options.now())));
      if (remainingWorkMs === 0) controller.abort(COLLABORATION_WORK_TIMEOUT);
      else workTimer = (options.workScheduler ?? systemTimerScheduler)(remainingWorkMs, () => controller.abort(COLLABORATION_WORK_TIMEOUT));

      let result: import("../../../../control/coordination-contract.js").CentralLearningFinishResult;
      let workAttempted = false;

      if (!enabled(options) || controller.signal.aborted) result = { kind: "cancelled", reason: abortReason() };
      else {
        workAttempted = true;

        try { result = await options.worker.run({ issue: funded.issue, jobId: funded.job.jobId, grantId: funded.grant.grantId, claimId,
          ...(centralSourceContext === undefined ? {} : { centralSourceContext }),
          dependencies: (claimed.state.learningDependencies ?? []).filter(d => d.jobId === funded.job.jobId),
          allowance: operation, remaining: { tokens: operation.maxTokens, calls: operation.maxCalls, steps: operation.maxSteps },
          funding: createCollaborationOperationFunding(funding(funded.grant.grantId, claimId), claimId, operation),
          signal: controller.signal }); }
        catch { result = { kind: "failed", reason: "learning_worker_failed" }; }

        if (!isCentralLearningFinishResult(result)) result = { kind: "failed", reason: "invalid_learning_work_result" };

        if (!enabled(options) || controller.signal.aborted) result = { kind: "cancelled", reason: abortReason() };
      }

      let yieldRevision: number | undefined;

      if (result.kind === "yielded") {
        const latest = await load();
        if (!latest.ok) return latest;

        const checked = coordinationForJob(latest.state, funded.job.jobId);
        if (checked === undefined || checked.issue.grantId !== funded.grant.grantId || checked.issue.decision.kind !== "focused_learning"
          || checked.issue.decision.revision !== funded.grant.focusRevision || checked.grant.claim?.claimId !== claimId) return failure("learning_claim_conflict");

        const evidence = collaborationRecoveryEvidence(latest.state, checked);
        if (evidence.kind === "inspection") result = { kind: "yielded", reason: evidence.reason };

        yieldRevision = checked.issue.revision;
      }

      const finished = await send({ kind: "finish", jobId: funded.job.jobId, claimId, result,
        ...(yieldRevision === undefined ? {} : { expectedIssueRevision: yieldRevision }) }, result.kind === "cancelled");
      if (!finished.ok) return { ...finished, ...(workAttempted ? { workAttempted: true as const } : {}) };

      if (result.kind !== "cancelled" && (!enabled(options) || controller.signal.aborted)) {
        return { ...failure("learning_aborted"), ...(workAttempted ? { workAttempted: true as const } : {}) };
      }

      const grant = finished.state.centralLearningGrants?.find(g => g.grantId === funded.grant.grantId);

      return { ok: true, status: result.kind === "yielded" ? "idle" : result.kind, issueId: funded.issue.issueId, jobId: funded.job.jobId, grantId: funded.grant.grantId,
        ...(workAttempted ? { workAttempted: true as const } : {}),
        ...(grant === undefined ? {} : { remaining: centralLearningRemaining(grant) }), result };
    } finally {
      workTimer?.cancel();
      input.signal?.removeEventListener("abort", abortFromCaller);
      running.delete(current.job.jobId);
    }
  };

  return {
    async report(input: ReportLearningIssueInput, signal?: AbortSignal): Promise<ControlResult<{ issue: LearningIssue }>> {
      if (!input || !coordinationScopeValid(input.scope)) return failure("invalid_learning_coordination");

      const issueId = input.issueId ?? `learning-issue:${contentHashOf([input.scope, input.problemKey])}`;
      const result = await send({ kind: "report", ...input, issueId }, false, signal);
      if (!result.ok) return result;

      // A committed report remains a fact if its caller stops afterwards.
      if (signal === undefined && !enabled(options)) return failure("collect_disabled");

      const issue = result.state.learningIssues?.find(i => i.scope === input.scope && i.problemKey === input.problemKey);

      return issue === undefined ? failure("learning_issue_not_found") : { ok: true, issue };
    },
    async decide(input: DecideLearningIssueInput): Promise<ControlResult<{ issue: LearningIssue }>> {
      const result = await send({ kind: "decide", ...input });
      if (!result.ok) return result;

      const issue = result.state.learningIssues?.find(i => i.issueId === input.issueId);
      if (issue !== undefined && issue.decision.kind !== "focused_learning") {
        for (const active of running.values()) if (active.issueId === issue.issueId) active.controller.abort(`personal_agent:${issue.decision.kind}`);
      }

      if (!enabled(options)) return failure("collect_disabled");

      return issue === undefined ? failure("learning_issue_not_found") : { ok: true, issue };
    },
    async fund(input: FundLearningIssueInput): Promise<ControlResult<{ issue: LearningIssue; grant: CentralLearningGrant; jobId: string }>> {
      const result = await send({ kind: "fund", ...input });
      if (!result.ok) return result;
      if (!enabled(options)) return failure("collect_disabled");
      const issue = result.state.learningIssues?.find(i => i.issueId === input.issueId);
      const grant = result.state.centralLearningGrants?.find(g => g.grantId === input.grantId);
      return issue === undefined || grant === undefined ? failure("learning_grant_not_found") : { ok: true, issue, grant, jobId: grant.jobId };
    },
    async updateDependency(input: ObserveLearningDependencyInput) {
      const result = await send({ kind: "dependency", ...input });
      if (!result.ok) return result;
      if (!enabled(options)) return failure("collect_disabled");
      return { ok: true as const, dependency: result.state.learningDependencies?.find(d => d.dependencyId === input.dependencyId) };
    },
    async resumeIncomplete(input: ResumeIncompleteCollaborationInput) {
      const result = await send({ kind: "resume_incomplete", ...input });
      if (!result.ok) return result;
      const grant = result.state.centralLearningGrants?.find(item => item.grantId === input.grantId);
      return grant === undefined ? failure("learning_grant_not_found") : { ok: true as const,
        jobId: grant.jobId, grantId: grant.grantId, remaining: centralLearningRemaining(grant),
        sourceRefs: [input.recoveryRef, input.checkpointReceiptId, input.failedReservationId] };
    },
    async read(scope: string) {
      if (!coordinationScopeValid(scope)) return failure("invalid_learning_coordination");
      const loaded = await load();
      if (!loaded.ok) return loaded;
      const issues = (loaded.state.learningIssues ?? []).filter(i => i.scope === scope);
      return { ok: true as const, issues, jobs: loaded.state.jobs.filter(j => j.scope === scope && j.coordination !== undefined),
        grants: (loaded.state.centralLearningGrants ?? []).filter(g => g.scope === scope),
        dependencies: (loaded.state.learningDependencies ?? []).filter(d => issues.some(i => i.issueId === d.issueId)) };
    },
    dispatch, recoverExpired,
  };
}
