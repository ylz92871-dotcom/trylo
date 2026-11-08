import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CentralStagePreparationInput } from "../../../../../integration/central-learning/contracts.js";
import { centralLearningRemaining, centralLearningSpent } from "../../../../control/coordination-contract.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "../../../../control/coordination-parse.js";
import type { FocusedLearningDispatch } from "../../../../control/focused-learning-port.js";
import type { LearningAllocationOffer } from "../../../../control/allocation-contract.js";
import { allocationFits } from "../../../../control/allocation-shape.js";
import { contentHashOf } from "../../../../control/hash.js";
import { TOOL_LEARNING_ALLOWANCE } from "../../../../control/tool-allowance.js";
import { identity } from "../../../../../validation/json-shape.js";
import { planVersionId, resultVersionId, validToolPipelineJobs } from "../domain/evolution/pipeline.js";
import { selectToolFocusedSource, toolCentralSemanticFingerprint, toolCentralStageIdentity } from "./central-source.js";
import { waitingToolJobReady } from "./pipeline-queue.js";
import { planForJob, resultForJob } from "./pipeline-records.js";
import type { ManagedToolFundingBinding } from "./learning-funding.js";
import { nominateToolLearningSource } from "./learning-funding.js";
import { observeToolCentralStage } from "./central-observation.js";
import type { CentralLearningContextReader, CentralLearningSourceContext } from "../../../../control/source-context.js";
import { readPreparedCentralStageContext } from "../../../../../integration/central-learning/prepared-context.js";
import type { ToolPipelineServices } from "./pipeline-services.js";
import { prepareToolPlanningContext } from "./pipeline-planning-context.js";
import { toolCentralCondition } from "./central-condition.js";
import { recoverExpiredToolLearning } from "./expired-recovery.js";
import { recoverManagedToolPrestart } from "./managed-prestart-recovery.js";
import { isKnownToolPlanningBoundary, isManagedToolCheckpointContinuation, isToolPlanningOutputRejection } from "../domain/evolution/managed-continuation.js";

export type ManagedToolStage = { readonly issueId: string; readonly grantId: string; readonly expectedIssueRevision: number;
  readonly stageRef: string; readonly policyRef: string; readonly sourceBindingRef: string; readonly offer: LearningAllocationOffer;
  readonly sourceContext?: CentralLearningSourceContext };

type ToolNominationResult = { readonly ok: true; readonly issueIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

type Options = {
  readonly boardRoot: string; readonly scope: string; readonly centralScope: string; readonly now: () => number;
  readonly authorized: () => boolean; readonly modelRef: string; readonly mode: "manual" | "after_turn";
  readonly executionAuthorized?: boolean;
  readonly contextForIssue?: CentralLearningContextReader;
  readonly contextServices?: Pick<ToolPipelineServices, "context" | "lookup">;
  /** The CLI host supplies its existing runToolCycle, with the exact binding forwarded into funding. */
  readonly run: (jobId: string, binding: ManagedToolFundingBinding, signal: AbortSignal) => Promise<{ readonly ok: boolean }>;
};

/** Dispatch one original pipeline task. It owns neither a worker implementation nor a second purse. */
export function createToolCentralLearning(options: Options) {
  const recover = async (signal: AbortSignal, issueId?: string) => {
    if (!options.authorized()) return { ok: false as const, reason: "tool_learning_authorization_required" };
    const prestart = await recoverManagedToolPrestart(options, signal, issueId);
    return prestart.ok ? recoverExpiredToolLearning(options, signal, issueId) : prestart;
  };
  const read = async (issueId: string) => {
    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return { ok: false as const, reason: loaded.reason };
    const issue = loaded.state.learningIssues?.find(item => item.issueId === issueId);
    const source = selectToolFocusedSource(loaded.state, issue, options.scope, options.centralScope);
    return source.ok && issue !== undefined ? { ok: true as const, state: loaded.state, source, issue }
      : { ok: false as const, reason: source.ok ? "tool_learning_source_unavailable" : source.code };
  };
  const prepare = async (input: CentralStagePreparationInput, signal: AbortSignal) => {
    const unavailable = (reason: string) => ({ status: "unavailable" as const, reason, sourceRefs: [input.issueId] });
    const waiting = (reason: string) => ({ status: "waiting" as const, reason, sourceRefs: [input.issueId] });
    const terminal = (reason: string) => ({ status: "terminal" as const, reason, sourceRefs: [input.issueId] });

    if (signal.aborted) return unavailable("learning_aborted");

    if (!options.authorized()) return unavailable("tool_learning_authorization_required");

    const operation = input.operationAllowance ?? input.authorizedAllowance;
    if (!identity(options.modelRef) || !isCentralLearningGrantAllowance(input.authorizedAllowance)
      || !isCentralLearningAllowance(operation)) return unavailable("tool_managed_configuration_invalid");

    // Provider-free recovery may append original claim/result facts. The host
    // reads a fresh numerical basis after every domain's preparation.
    const recovered = await recover(signal, input.issueId);
    if (!recovered.ok) return unavailable(recovered.reason);

    const inspection = recovered.results.find(item => item.status === "inspection_required");
    if (inspection !== undefined) return { ...waiting(inspection.reason ?? "tool_expired_sent_attempt_requires_inspection"),
      sourceRefs: [input.issueId, ...(inspection.sourceRefs ?? [])],
      ...(inspection.operatorRoute === undefined ? {} : { operatorRoute: inspection.operatorRoute }) };

    const current = await read(input.issueId);
    if (!current.ok) return unavailable(current.reason);

    const { state, source, issue } = current, job = source.job;

    if (issue.decision.kind !== "focused_learning") return unavailable("learning_issue_not_focused");

    const grant = state.centralLearningGrants?.find(item => item.grantId === source.grantId);
    if (grant !== undefined && grant.budgetId === undefined) return unavailable("tool_original_grant_is_independent");

    const planningBoundary = isKnownToolPlanningBoundary(state, job.jobId, resultVersionId(job.jobId, job.attempt));
    const manualCheckpoint = options.mode === "manual" && options.executionAuthorized === true
      && isManagedToolCheckpointContinuation(state, job.jobId, resultVersionId(job.jobId, job.attempt));
    const previous = resultForJob(state, job.jobId, job.attempt);
    if (previous !== undefined && isToolPlanningOutputRejection(previous.code) && !planningBoundary) {
      return waiting("tool_planning_original_accounting_unresolved");
    }

    if (grant?.status === "closed" || ["succeeded", "cancelled", "expired"].includes(job.state) || job.state === "failed" && !planningBoundary && !manualCheckpoint
      || job.breakerOpen && !planningBoundary && !manualCheckpoint
      || job.attempt >= job.maxAttempts && !isManagedToolCheckpointContinuation(state, job.jobId, resultVersionId(job.jobId, job.attempt))) {
      return terminal("tool_original_task_terminal");
    }

    if (grant?.claim !== undefined || grant?.reservations.some(item => item.state === "reserved") || job.state === "running") {
      return waiting("tool_original_worker_in_flight");
    }

    if (job.state === "waiting_approval") return waiting("tool_original_approval_required");

    const previousCode = previous?.previousCode ?? previous?.code;
    // A declared new resource segment may be quoted before it is funded. The
    // original worker will still require the actual changed allowance on dispatch.
    const resourceBoundary = previousCode === "learning_budget_exhausted" || previousCode === "learning_allowance_required";
    if (job.state === "waiting_evidence" && !planningBoundary && !resourceBoundary && !waitingToolJobReady(state, job, source.plan, options.mode,
      options.executionAuthorized === true, options.mode === "manual")) return waiting("tool_original_new_evidence_required");

    if (source.plan.fundingOrigin !== undefined) return waiting("tool_acquisition_review_uses_original_materializer");

    const centralSourceContext = await options.contextForIssue?.(issue.issueId);
    const stage = toolCentralStageIdentity(state, source, options.mode, options.modelRef, centralSourceContext);
    if (!stage.ok) return unavailable(stage.code);

    const spent = grant === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(grant), authorized = input.authorizedAllowance;
    // Private worker caps bound this dispatch; original spent is deducted only
    // from the independently authorized cumulative grant ceiling.
    const tokens = Math.min(authorized.maxTokens - spent.tokens, operation.maxTokens, TOOL_LEARNING_ALLOWANCE.maxTokens);
    const calls = Math.min(authorized.maxCalls - spent.calls, authorized.maxSteps - spent.steps,
      operation.maxCalls, operation.maxSteps, TOOL_LEARNING_ALLOWANCE.maxCalls);
    // Quote the caller's explicit text authority. Normal stage funding may
    // expand the old grant; its legacy default is not a second caller limit.
    const maxPromptChars = Math.min(authorized.maxPromptChars, operation.maxPromptChars);
    if (tokens < 128 || calls < 1 || maxPromptChars > authorized.maxPromptChars || maxPromptChars > operation.maxPromptChars) {
      return unavailable("tool_authorized_stage_envelope_exhausted");
    }

    const offer: LearningAllocationOffer = { offerId: `tool-offer:${contentHashOf({ stageRef: stage.stageRef, tokens, calls, maxPromptChars })}`,
      owner: { plane: "agent", domain: "tool" }, policyRef: stage.policyRef, reserve: { tokens, calls, steps: calls }, maxPromptChars };
    const planning = await prepareToolPlanningContext({ boardRoot: options.boardRoot, plan: source.plan, jobId: source.jobId,
      attempt: job.attempt + 1, search: previous?.search ?? { status: "complete", candidates: [], failures: [] }, signal,
      services: { ...options.contextServices, ...(centralSourceContext === undefined ? {} : { centralSourceContext }) } }, {
      grantId: source.grantId, maxTokens: tokens, maxCalls: calls, tokensRemaining: tokens, callsRemaining: calls, maxPromptChars });
    if (!planning.ok) return unavailable(planning.code);

    // Pin the frozen stage to the latest program for this exact native task.
    const sourceReports = issue.reports.filter(item => "subsystem" in item.source && item.source.subsystem === "tool"
      && item.source.versionId === source.jobId);
    const report = [...sourceReports].reverse().find(item => item.reportId.startsWith("central-research-program-report:")
      && "taskId" in item.source && item.source.taskId === source.plan.trigger.runId) ?? sourceReports[0];
    if (report === undefined) return unavailable("tool_learning_source_unavailable");

    const condition = toolCentralCondition(planning.state, source.plan);

    if (signal.aborted) return unavailable("learning_aborted");

    return { status: "ready" as const, stageRef: stage.stageRef, policyRef: stage.policyRef, offer, authorizedAllowance: authorized,
      ...(centralSourceContext === undefined ? {} : { sourceContext: { ...centralSourceContext } }),
      policyFamily: { ref: stage.policyRef, sourceRef: stage.policyRef, response: "shared_or_exact_treatment" as const },
      ...(condition === undefined ? {} : { condition }),
      source: { issueId: issue.issueId, grantId: source.grantId, sourceBindingRef: stage.sourceBindingRef, domainStage: {
        stageRef: stage.stageRef, policyRef: stage.policyRef, kind: grant === undefined || grant.reservations.length === 0 ? "initial" as const : "continuation" as const,
        sourceReportId: report.reportId, readiness: { kind: "ready" as const,
          evidenceRefs: [...new Set([planVersionId(source.jobId), ...(previous === undefined ? [] : [resultVersionId(source.jobId, previous.attempt)]),
            ...source.plan.trigger.evidenceRefs])].slice(0, 32) } } } };
  };
  const dispatch = async (input: ManagedToolStage, signal: AbortSignal): Promise<FocusedLearningDispatch> => {
    const failed = (reason: string): FocusedLearningDispatch => ({ ok: false, reason });

    if (signal.aborted) return failed("learning_aborted");

    if (!options.authorized()) return failed("tool_learning_authorization_required");

    const recovered = await recover(signal, input.issueId);
    if (!recovered.ok) return failed(recovered.reason);

    if (recovered.results.some(item => item.status === "inspection_required")) return failed("tool_expired_sent_attempt_requires_inspection");

    const current = await read(input.issueId);
    if (!current.ok) return failed(current.reason);

    const { state, source, issue } = current;
    const prepared = await readPreparedCentralStageContext({ boardRoot: options.boardRoot, scope: options.centralScope, input,
      ...(options.contextForIssue === undefined ? {} : { reader: options.contextForIssue }) });
    if (prepared.status !== "ready") return failed(prepared.reason);

    const centralSourceContext = prepared.context;
    const stage = toolCentralStageIdentity(state, source, options.mode, options.modelRef, centralSourceContext);
    const grant = state.centralLearningGrants?.find(item => item.grantId === input.grantId);
    if (!stage.ok || grant === undefined || grant.budgetId === undefined || grant.grantId !== source.grantId
      || grant.domain !== "tool" || grant.scope !== options.centralScope || grant.issueId !== issue.issueId
      || issue.grantId !== grant.grantId || issue.jobId !== grant.jobId || issue.revision !== input.expectedIssueRevision
      || issue.decision.kind !== "focused_learning" || grant.focusRevision !== issue.decision.revision || grant.status !== "open"
      || stage.stageRef !== input.stageRef || stage.policyRef !== input.policyRef || stage.sourceBindingRef !== input.sourceBindingRef
      || input.offer.owner.plane !== "agent" || input.offer.owner.domain !== "tool" || input.offer.policyRef !== stage.policyRef
      || input.offer.reserve.tokens > TOOL_LEARNING_ALLOWANCE.maxTokens || input.offer.reserve.calls > TOOL_LEARNING_ALLOWANCE.maxCalls
      || input.offer.reserve.steps > TOOL_LEARNING_ALLOWANCE.maxSteps
      || !allocationFits(input.offer.reserve, centralLearningRemaining(grant)) || input.offer.maxPromptChars > grant.allowance.maxPromptChars) {
      return failed("tool_managed_stage_binding");
    }

    if (source.job.state === "running" || grant.claim !== undefined || grant.reservations.some(item => item.state === "reserved")) {
      return { ok: true, status: "busy", issueId: issue.issueId, jobId: source.jobId, grantId: grant.grantId };
    }

    const binding: ManagedToolFundingBinding = { issueId: issue.issueId, grantId: grant.grantId, budgetId: grant.budgetId,
      expectedIssueRevision: input.expectedIssueRevision, semanticFingerprint: toolCentralSemanticFingerprint(state, source.plan),
      ...(centralSourceContext === undefined ? {} : { centralSourceContext: { ...centralSourceContext } }),
      stage: { chargedAtStart: centralLearningSpent(grant), allowance: {
        schemaVersion: 2, unit: "total_model_tokens", maxTokens: input.offer.reserve.tokens, maxCalls: input.offer.reserve.calls,
        maxSteps: input.offer.reserve.steps, maxPromptChars: input.offer.maxPromptChars } } };
    let worked: { readonly ok: boolean };

    try { worked = await options.run(source.jobId, binding, signal); }
    catch { return { ok: false, reason: "tool_managed_worker_failed", workAttempted: true }; }

    const after = await read(input.issueId);
    if (!after.ok) return { ok: false, reason: after.reason, workAttempted: true };

    const job = after.source.job, result = resultForJob(after.state, job.jobId, job.attempt);
    const currentGrant = after.state.centralLearningGrants?.find(item => item.grantId === grant.grantId);
    const resultRefs = result === undefined ? [] : [resultVersionId(job.jobId, job.attempt),
      ...(result.candidateVersionId === undefined ? [] : [result.candidateVersionId]),
      ...(result.contractProposalId === undefined ? [] : [result.contractProposalId])];
    const status = signal.aborted || job.state === "cancelled" ? "cancelled" as const : job.state === "running" ? "busy" as const
      : job.state === "waiting_approval" || job.state === "waiting_evidence" ? "waiting_dependency" as const
        : job.state === "succeeded" ? "completed" as const : job.state === "failed" || job.state === "expired" ? "failed" as const : "idle" as const;

    if (!worked.ok && result === undefined) return { ok: false, reason: "tool_managed_dispatch_failed", workAttempted: true };

    return { ok: true, status, workAttempted: true, issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId,
      ...(currentGrant === undefined ? {} : { remaining: centralLearningRemaining(currentGrant) }),
      ...(resultRefs.length === 0 ? {} : { result: { kind: "completed", resultRefs } }) };
  };
  const nominateResult = async (signal: AbortSignal): Promise<ToolNominationResult> => {
    if (signal.aborted || !options.authorized()) return { ok: true, issueIds: [] };

    const recovered = await recover(signal);
    if (!recovered.ok) return { ok: false, reason: recovered.reason };

    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };

    if (!validToolPipelineJobs(loaded.state)) return { ok: false, reason: "invalid_pipeline_job" };

    const issueIds: string[] = [];

    for (const job of loaded.state.jobs) {
      if (signal.aborted) break;

      if (job.domain !== "tool" || job.scope !== options.scope || (job.state !== "queued" && job.state !== "waiting_evidence"
        && !isKnownToolPlanningBoundary(loaded.state, job.jobId, resultVersionId(job.jobId, job.attempt)))) continue;

      const plan = planForJob(loaded.state, job.jobId);
      if (plan === undefined || plan.fundingOrigin !== undefined) continue;

      const nominated = await nominateToolLearningSource(options, plan, signal);
      if (!nominated.ok) return { ok: false, reason: nominated.code };

      issueIds.push(nominated.issueId);
    }

    return { ok: true, issueIds: [...new Set(issueIds)] };
  };
  // Preserve existing native callers' array/throw contract over the same owner.
  const nominate = async (signal: AbortSignal): Promise<readonly string[]> => {
    const result = await nominateResult(signal);
    if (!result.ok) throw new Error(`tool_nomination:${result.reason}`);
    return result.issueIds;
  };

  return { recover, nominate, nominateResult, prepare, dispatch, observe: (input: ManagedToolStage, signal: AbortSignal) => observeToolCentralStage(options, input, signal) };
}
