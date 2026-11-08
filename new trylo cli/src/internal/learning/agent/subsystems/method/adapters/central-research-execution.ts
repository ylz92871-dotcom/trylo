import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ProviderPort } from "../../../../../ports/provider.js";
import type { CentralLearningExecutionPort, CentralFundedStage, CentralStagePreparation, CentralStageObservation } from "../../../../../integration/central-learning/contracts.js";
import { allocationFits } from "../../../../control/allocation-shape.js";
import { centralLearningRemaining, centralLearningSpent, type CentralLearningGrant, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { CentralLearningContextReader } from "../../../../control/source-context.js";
import type { FocusedLearningDispatch } from "../../../../control/focused-learning-port.js";
import { methodResearchGrantId, methodResearchIssueId, methodResearchRecord, readMethodResearch,
  type MethodResearchStep, type MethodResearchUnsent, type MethodResearchRejected } from "./central-research-records.js";
import { METHOD_RESEARCH_INSTRUCTION, runCentralMethodResearchModel } from "./central-research-model.js";
import type { CentralMethodResearchIntakeOptions } from "./central-research-intake.js";
import { METHOD_RESEARCH_TIMING, prepareMethodResearchEnvelope } from "./central-research-capacity.js";
import type { TimerScheduler } from "../../../../../subagent/scheduler.js";
import { publishCentralMethodResearchCandidate, readCentralMethodResearchCandidates } from "./central-research-candidate.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "../../../../control/coordination-parse.js";
import { readCentralStageContext } from "../../../../../integration/central-learning/source-context.js";
import { readPreparedCentralStageContext } from "../../../../../integration/central-learning/prepared-context.js";
import { recoverCentralMethodResearchRejection } from "./central-research-recovery.js";

type Options = CentralMethodResearchIntakeOptions & { readonly provider: ProviderPort; readonly model: string; readonly scheduler?: TimerScheduler;
  readonly modelRef?: string; readonly contextWindow?: number; readonly contextForIssue?: CentralLearningContextReader };

function sourceOf(state: BoardState, scope: string, issueId: string) {
  const issue = state.learningIssues?.find(row => row.scope === scope && row.issueId === issueId);
  const report = issue?.reports.find(row => "kind" in row.source && row.source.kind === "research_request" && row.source.domain === "prompt");
  if (issue === undefined || report === undefined || !("requestRef" in report.source)) return undefined;

  const requestRef = report.source.requestRef, intentRef = report.source.intentRef;
  if (issue.issueId !== methodResearchIssueId(requestRef) || issue.reports.some(row => !("kind" in row.source)
    || row.source.kind !== "research_request" || row.source.domain !== "prompt" || row.source.requestRef !== requestRef
    || row.source.intentRef !== intentRef)) throw new Error("method_research_source_owner_conflict");

  const history = readMethodResearch(state, scope, report.source.requestRef);
  if (history === undefined || report.source.intentRef !== history.request.intentRef) throw new Error("method_research_source_missing");

  const reception = [...issue.reports].reverse().find(row => row.reportId.startsWith("central-research-program-report:")
    && "kind" in row.source && row.source.kind === "research_request" && row.source.domain === "prompt"
    && row.source.requestRef === requestRef && row.source.intentRef === intentRef);

  return { issue, report: reception ?? report, history };
}

type Source = NonNullable<ReturnType<typeof sourceOf>>;

function researchRecoveryBoundary(source: Source, grant: CentralLearningGrant | undefined) {
  if (grant?.reservations.some(row => row.state === "reserved" || row.usage?.kind === "unknown")) return "method_research_original_work_requires_recovery";
  if (grant?.reservations.some(row => !source.history.checkpoints.some(step => step.step.reservationId === row.reservationId))) return "method_research_sent_step_has_no_checkpoint";
  return undefined;
}

function stageProgress(state: BoardState, scope: string, source: Source, input: CentralFundedStage) {
  const inputHash = contentHashOf(input), steps = source.history.steps.filter(row => row.step.stageInputHash === inputHash);
  const checkpoints = source.history.checkpoints.filter(row => row.step.stageInputHash === inputHash);
  const refs = new Set(steps.map(row => row.ref));
  const candidates = readCentralMethodResearchCandidates(state, scope, source.history.request.requestRef)
    .filter(row => refs.has(row.checkpointRef));
  return { steps, candidates, checkpoints, resultRefs: [...checkpoints.map(row => row.ref), ...candidates.map(row => row.versionId)] };
}

const contextRef = (context: Awaited<ReturnType<CentralLearningContextReader>>, source: Source) => context?.ref ?? source.history.requestId;

function envelope(source: Source, context: Awaited<ReturnType<CentralLearningContextReader>>, tokens: number, promptChars: number,
  provider: ProviderPort, contextWindow: number | undefined) {
  const { request, steps } = source.history;
  const last = source.history.checkpoints.at(-1)?.step;
  const material = canonicalJson({ role: "method_research_not_business_observations", request,
    currentPurpose: context ?? null, priorPublicFindings: steps.slice(-8),
    lastOutputRejection: last?.type === "method_research_rejected"
      ? { reason: "The previous paid response failed the JSON finding contract. Follow the exact current output shape and bounds; it is not a finding.",
        ...(last.evidence.kind === "response" && last.evidence.rejectedField !== undefined
          ? { rejectedField: last.evidence.rejectedField } : {}) } : null });
  const capacity = prepareMethodResearchEnvelope({ provider, tokens, maxPromptChars: promptChars,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    messages: [{ role: "system", content: METHOD_RESEARCH_INSTRUCTION }, { role: "user", content: material }] });

  return capacity === undefined ? undefined : { material, ...capacity };
}

function stageOf(source: Source, context: Awaited<ReturnType<CentralLearningContextReader>>, modelRef: string) {
  const stageRef = `method-research-stage:${contentHashOf([source.history.headRef, contextRef(context, source), modelRef])}`;
  const policyRef = `method-research-policy:${contentHashOf(["public-source-method-research-v2-grant-capacity", modelRef])}`;
  return { stageRef, policyRef, sourceBindingRef: `method-research-source:${contentHashOf([source.history.requestId, stageRef])}` };
}

/** This branch owns native method research requests; the original qualified
 * experience review, maturity and application lifecycle remain with the delegate.
 */
export function createCentralMethodResearchExecution(options: Options, original: CentralLearningExecutionPort): CentralLearningExecutionPort {
  const active = (signal: AbortSignal) => options.enabled() && !signal.aborted;
  const load = async () => {
    const result = await createBoardReader(options.boardRoot).load();
    if (!result.ok) throw new Error(result.reason);
    return result.state;
  };
  const act = async (store: BoardStore, action: CoordinationAction) => {
    const result = await store.apply({ type: "coordinate_learning", commandId: `method-research:${contentHashOf(action)}`,
      issuedAt: new Date(options.now()).toISOString(), action });
    if (!result.ok) throw new Error(result.reason);
    return result.state;
  };
  const prepare: CentralLearningExecutionPort["prepare"] = async (input, signal) => {
    if (!active(signal)) return { status: "waiting", reason: "method_research_inactive", sourceRefs: [input.issueId] };

    const state = await load(), source = sourceOf(state, options.scope, input.issueId);
    if (source === undefined) return original.prepare(input, signal);

    const wait = (reason: string): CentralStagePreparation => ({ status: "waiting", reason, sourceRefs: [source.history.headRef] });

    if (!active(signal)) return wait("method_research_inactive");

    if (!isCentralLearningGrantAllowance(input.authorizedAllowance)
      || !isCentralLearningAllowance(input.operationAllowance ?? input.authorizedAllowance)) return wait("method_research_authorized_operation_invalid");

    const operation = input.operationAllowance ?? input.authorizedAllowance;

    if (source.issue.decision.kind !== "focused_learning") return wait("learning_issue_not_focused");

    const grant = state.centralLearningGrants?.find(row => row.grantId === methodResearchGrantId(source.history.request.requestRef));
    const job = state.jobs.find(row => row.jobId === grant?.jobId);

    if (grant?.status === "closed") return { status: "terminal", reason: "method_research_grant_closed", sourceRefs: [source.history.headRef] };

    if (grant?.claim !== undefined && Date.parse(grant.claim.expiresAt) <= options.now()
      && grant.reservations.every(row => row.state === "settled" && row.usage?.kind === "reported"
        && source.history.checkpoints.some(step => step.step.reservationId === row.reservationId))) {
      const recovered = await withBoardWriter(options.boardRoot, async store => {
        const loaded = await store.load();
        if (!loaded.ok) throw new Error(loaded.reason);

        const current = loaded.state.centralLearningGrants?.find(row => row.grantId === grant.grantId);
        if (current?.claim?.claimId !== grant.claim!.claimId || Date.parse(current.claim.expiresAt) > options.now()) return loaded.state;

        const latest = sourceOf(loaded.state, options.scope, input.issueId);
        if (latest === undefined || latest.issue.revision !== source.issue.revision || latest.issue.decision.kind !== "focused_learning"
          || latest.issue.decision.revision !== current.focusRevision || latest.issue.grantId !== current.grantId
          || current.grantId !== methodResearchGrantId(latest.history.request.requestRef) || current.scope !== options.scope
          || current.domain !== "prompt" || current.budgetId === undefined || current.status !== "open"
          || !current.reservations.every(row => row.state === "settled" && row.usage?.kind === "reported"
          && latest.history.checkpoints.some(step => step.step.reservationId === row.reservationId))) return loaded.state;

        return act(store, { kind: "finish", jobId: current.jobId, claimId: current.claim.claimId, expectedIssueRevision: latest.issue.revision,
          result: { kind: "yielded", reason: "method_research_confirmed_expired_boundary" } });
      }, { commandGuard: () => active(signal) });
      if ("ok" in recovered) return wait(recovered.reason);

      if (recovered.centralLearningGrants?.find(row => row.grantId === grant.grantId)?.claim !== undefined) return wait("method_research_original_work_requires_recovery");

      return prepare(input, signal);
    }

    if (grant?.claim !== undefined || job?.state === "running") {
      return wait("method_research_original_work_requires_recovery");
    }

    const recovery = researchRecoveryBoundary(source, grant);
    if (recovery !== undefined) return wait(recovery);

    // A confirmed paid candidate may need only its local card/scope publication
    // completed after a crash. Reuse the original checkpoint without another call.
    const pendingCandidate = source.history.steps.at(-1);
    const published = readCentralMethodResearchCandidates(state, options.scope, source.history.request.requestRef);
    if (pendingCandidate?.step.finding.kind === "candidate" && !published.some(row => row.checkpointRef === pendingCandidate.ref)) await publishCentralMethodResearchCandidate(options,
      { request: source.history.request, finding: pendingCandidate.step.finding,
        reservationId: pendingCandidate.step.reservationId, checkpointRef: pendingCandidate.ref }, signal);

    const material = await readCentralStageContext(options.contextForIssue, input.issueId);
    if (material.status !== "ready") return wait(material.reason);

    const refreshed = sourceOf(await load(), options.scope, input.issueId);
    if (refreshed === undefined || refreshed.issue.revision !== source.issue.revision
      || refreshed.report.reportId !== source.report.reportId || refreshed.history.headRef !== source.history.headRef) {
      return wait("method_research_preparation_source_changed");
    }

    const context = material.context, latest = source.history.steps.at(-1)?.step;
    if (latest !== undefined && latest.finding.kind !== "finding" && latest.contextRef === contextRef(context, source)) return wait("method_research_new_material_or_direction_required");

    const previous = source.history.steps.at(-2)?.step;
    if (latest !== undefined && previous !== undefined && latest.contextRef === contextRef(context, source)
      && canonicalJson(latest.finding) === canonicalJson(previous.finding)) return wait("method_research_no_semantic_progress");

    const spent = grant === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(grant);
    const tokens = Math.min(input.authorizedAllowance.maxTokens - spent.tokens, operation.maxTokens);
    const calls = Math.min(input.authorizedAllowance.maxCalls - spent.calls, operation.maxCalls);
    const steps = Math.min(input.authorizedAllowance.maxSteps - spent.steps, operation.maxSteps);
    const maxPromptChars = Math.min(input.authorizedAllowance.maxPromptChars, operation.maxPromptChars);
    const packed = envelope(source, context, tokens, maxPromptChars, options.provider, options.contextWindow);
    if (calls < 1 || steps < 1 || packed === undefined) return wait("method_research_prompt_or_budget_boundary");

    const stage = stageOf(source, context, options.modelRef ?? options.model);

    return { status: "ready", ...stage, authorizedAllowance: input.authorizedAllowance,
      ...(context === undefined ? {} : { sourceContext: context }),
      offer: { offerId: `method-research-offer:${contentHashOf([stage.stageRef, tokens, calls, steps, maxPromptChars])}`,
        owner: { plane: "agent", domain: "prompt" }, policyRef: stage.policyRef,
        reserve: { tokens, calls, steps }, maxPromptChars },
      source: { issueId: source.issue.issueId, grantId: methodResearchGrantId(source.history.request.requestRef),
        sourceBindingRef: stage.sourceBindingRef, domainStage: { stageRef: stage.stageRef, policyRef: stage.policyRef,
          kind: source.history.checkpoints.length === 0 ? "initial" : "continuation", sourceReportId: source.report.reportId,
          readiness: { kind: "ready", evidenceRefs: [source.history.headRef] } } } };
  };
  const observe = async (input: CentralFundedStage, signal: AbortSignal): Promise<CentralStageObservation> => {
    const state = await load(), source = sourceOf(state, options.scope, input.issueId);
    if (source === undefined) return original.observe(input, signal);

    const grant = state.centralLearningGrants?.find(row => row.grantId === input.grantId);
    const job = state.jobs.find(row => row.jobId === grant?.jobId);
    const { steps, candidates, checkpoints, resultRefs } = stageProgress(state, options.scope, source, input);

    return { outcome: candidates.length > 0 ? "qualified"
      : checkpoints.length === 0 || job?.state === "running" || grant?.reservations.some(row => row.state === "reserved") ? "pending" : "closed_no_result",
      resultRefs, sourceRefs: [source.history.requestId, source.history.request.intentRef],
      reason: candidates.length > 0 ? "method_research_native_source_candidate_delivered_not_effectiveness"
        : checkpoints.at(-1)?.step.type === "method_research_rejected" ? "method_research_output_invalid"
          : steps.length === 0 && checkpoints.length > 0 ? "method_research_confirmed_not_sent"
          : resultRefs.length === 0 ? "method_research_no_confirmed_finding" : "method_research_public_progress_not_qualified_method" };
  };
  const dispatch: CentralLearningExecutionPort["dispatch"] = async (input, signal) => {
    if (!active(signal)) return { ok: false, reason: "method_research_inactive" };

    const state = await load(), source = sourceOf(state, options.scope, input.issueId);
    if (source === undefined) return original.dispatch(input, signal);

    if (!active(signal)) return { ok: false, reason: "method_research_inactive" };

    if (researchRecoveryBoundary(source, state.centralLearningGrants?.find(row => row.grantId === input.grantId)) === "method_research_sent_step_has_no_checkpoint") {
      const recovered = await recoverCentralMethodResearchRejection({ boardRoot: options.boardRoot, scope: options.scope,
        input, model: options.model, now: options.now, enabled: options.enabled }, signal);
      if (recovered !== undefined) return { ok: true, status: "completed", issueId: input.issueId, grantId: input.grantId,
        jobId: state.centralLearningGrants!.find(row => row.grantId === input.grantId)!.jobId,
        result: { kind: "completed", resultRefs: [recovered] } };
    }

    const material = await readPreparedCentralStageContext({ boardRoot: options.boardRoot, scope: options.scope, input,
      ...(options.contextForIssue === undefined ? {} : { reader: options.contextForIssue }) });
    if (material.status !== "ready") return { ok: false, reason: material.reason };

    const context = material.context, stage = stageOf(source, context, options.modelRef ?? options.model);
    const grant = state.centralLearningGrants?.find(row => row.grantId === input.grantId), job = state.jobs.find(row => row.jobId === grant?.jobId);
    if (grant === undefined || job === undefined || grant.grantId !== methodResearchGrantId(source.history.request.requestRef)
      || grant.budgetId === undefined || grant.domain !== "prompt" || grant.scope !== options.scope || grant.issueId !== input.issueId
      || source.issue.revision !== input.expectedIssueRevision || source.issue.decision.kind !== "focused_learning"
      || source.issue.decision.revision !== grant.focusRevision || grant.status !== "open"
      || input.stageRef !== stage.stageRef || input.policyRef !== stage.policyRef || input.sourceBindingRef !== stage.sourceBindingRef
      || input.offer.owner.plane !== "agent" || input.offer.owner.domain !== "prompt" || input.offer.policyRef !== stage.policyRef
      || !isCentralLearningAllowance({ schemaVersion: 2, unit: "total_model_tokens", maxTokens: input.offer.reserve.tokens,
        maxCalls: input.offer.reserve.calls, maxSteps: input.offer.reserve.steps, maxPromptChars: input.offer.maxPromptChars })
      || input.offer.maxPromptChars > grant.allowance.maxPromptChars
      || !allocationFits(input.offer.reserve, centralLearningRemaining(grant))) return { ok: false, reason: "method_research_stage_binding" };

    if (grant.claim !== undefined || job.state === "running") return { ok: true, status: "busy", issueId: input.issueId, jobId: job.jobId, grantId: grant.grantId };

    const recovery = researchRecoveryBoundary(source, grant);
    if (recovery !== undefined) return { ok: false, reason: recovery };

    const provider = options.provider.fork?.([]);
    if (provider === undefined || provider === options.provider) return { ok: false, reason: "method_research_provider_isolation" };

    const claimId = `method-research-claim:${contentHashOf([input.stageRef, job.attempt + 1])}`;
    const startedAt = options.now();
    const claimed = await withBoardWriter(options.boardRoot, store => act(store, { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt,
      claimId, ownerId: source.history.request.requestRef, expiresAt: new Date(startedAt + METHOD_RESEARCH_TIMING.claimLeaseMs).toISOString(), expectedIssueRevision: input.expectedIssueRevision }),
    { commandGuard: () => active(signal) });
    if ("ok" in claimed) throw new Error(claimed.reason);

    return work({ options, provider, input, claimId, context, load, act, active, deadline: startedAt + METHOD_RESEARCH_TIMING.timeoutMs,
      chargedAtStart: centralLearningSpent(grant).tokens }, signal);
  };

  return { ...original, prepare, dispatch, observe };
}

type WorkInput = { readonly options: Options; readonly provider: ProviderPort; readonly input: CentralFundedStage; readonly claimId: string;
  readonly context: Awaited<ReturnType<CentralLearningContextReader>>; readonly load: () => Promise<BoardState>;
  readonly act: (store: BoardStore, action: CoordinationAction) => Promise<BoardState>; readonly active: (signal: AbortSignal) => boolean;
  readonly chargedAtStart: number; readonly deadline: number };

async function work(work: WorkInput, signal: AbortSignal): Promise<FocusedLearningDispatch> {
  const { options, input, act } = work;
  let reason = "method_research_budget_boundary", attempted = false;

  for (let step = 0; step < input.offer.reserve.calls && step < input.offer.reserve.steps && work.active(signal); step++) {
    const state = await work.load(), source = sourceOf(state, options.scope, input.issueId);
    const grant = state.centralLearningGrants?.find(row => row.grantId === input.grantId);
    if (source === undefined || grant?.claim?.claimId !== work.claimId) throw new Error("method_research_claim_lost");

    const spent = centralLearningSpent(grant), remaining = centralLearningRemaining(grant);
    const stageTokens = input.offer.reserve.tokens - Math.max(0, spent.tokens - work.chargedAtStart);

    if (options.now() >= work.deadline) {
      reason = "method_research_timeout";
      break;
    }

    const packed = envelope(source, work.context, Math.min(remaining.tokens, stageTokens), input.offer.maxPromptChars, work.provider, options.contextWindow);
    if (packed === undefined || remaining.calls < 1 || remaining.steps < 1) break;

    const reservationId = `method-research-call:${contentHashOf([input.stageRef, source.history.headRef, options.model])}`;
    if (grant.reservations.some(row => row.reservationId === reservationId)) throw new Error("method_research_call_already_reserved");

    const reserved = await withBoardWriter(options.boardRoot, async store => options.now() >= work.deadline ? undefined
      : act(store, { kind: "reserve", grantId: input.grantId, claimId: work.claimId, reservationId, maxTokens: packed.maxTokens }),
    { commandGuard: () => work.active(signal) });
    if (reserved === undefined) {
      reason = "method_research_timeout";
      break;
    }

    if ("ok" in reserved) throw new Error(reserved.reason);

    // The reservation may have waited for the Board writer. Never start a late
    // call with a fresh full timeout after the original stage deadline.
    const timeoutMs = work.deadline - options.now();
    if (timeoutMs <= 0 || !work.active(signal)) {
      const unsent = await withBoardWriter(options.boardRoot, store => act(store, { kind: "settle", grantId: input.grantId,
        reservationId, usage: { kind: "reported", totalTokens: 0, inputTokens: 0, outputTokens: 0, model: options.model } }));
      if ("ok" in unsent) throw new Error(unsent.reason);

      await persistResearchCheckpoint(work, { type: "method_research_unsent", schemaVersion: 1,
        requestRef: source.history.request.requestRef, previousRef: source.history.headRef, reservationId,
        contextRef: contextRef(work.context, source), stageInputHash: contentHashOf(input),
        reason: timeoutMs <= 0 ? "deadline_before_send" : "cancelled_before_send" });
      reason = signal.aborted ? "method_research_cancelled" : "method_research_timeout";
      break;
    }

    attempted = true;
    const response = await runCentralMethodResearchModel({ provider: work.provider, model: options.model,
      reservationId, ...packed, timeoutMs, enabled: options.enabled,
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }) }, signal);
    // Settlement remains authorized after collection closes or cancellation arrives.
    const settled = await withBoardWriter(options.boardRoot, store => act(store, { kind: "settle", grantId: input.grantId, reservationId, usage: response.settlement }));
    if ("ok" in settled) throw new Error(settled.reason);

    if (response.reason !== undefined || response.finding === undefined) {
      reason = response.reason ?? "method_research_no_finding";

      if (response.rejectedOutputHash !== undefined) await persistResearchCheckpoint(work, {
        type: "method_research_rejected", schemaVersion: 1, requestRef: source.history.request.requestRef,
        previousRef: source.history.headRef, reservationId, contextRef: contextRef(work.context, source),
        stageInputHash: contentHashOf(input), reason: "method_research_output_invalid",
        evidence: { kind: "response", outputHash: response.rejectedOutputHash,
          ...(response.rejectedField === undefined ? {} : { rejectedField: response.rejectedField }) } });

      break;
    }

    const finding = response.finding;
    const repeated = source.history.steps.some(row => canonicalJson(row.step.finding) === canonicalJson(finding));
    const value: MethodResearchStep = { type: "method_research_step", schemaVersion: 1, requestRef: source.history.request.requestRef,
      previousRef: source.history.headRef, reservationId, contextRef: contextRef(work.context, source), stageInputHash: contentHashOf(input), finding };
    const checkpointRef = await persistResearchCheckpoint(work, value);

    if (finding.kind === "candidate") await publishCentralMethodResearchCandidate(options,
      { request: source.history.request, finding, reservationId, checkpointRef }, signal);

    if (repeated || response.settlement.kind === "unknown" || finding.kind !== "finding") {
      reason = repeated ? "method_research_no_semantic_progress" : `method_research_${finding.kind}`;
      break;
    }
  }

  const state = await work.load(), source = sourceOf(state, options.scope, input.issueId);
  const grant = state.centralLearningGrants?.find(row => row.grantId === input.grantId);
  if (source === undefined || grant === undefined) throw new Error("method_research_source_missing");

  if (grant.status === "open" && grant.claim?.claimId === work.claimId) {
    const finished = await withBoardWriter(options.boardRoot, store => act(store,
      { kind: "finish", jobId: grant.jobId, claimId: work.claimId, expectedIssueRevision: input.expectedIssueRevision,
        result: { kind: "yielded", reason } }));
    if ("ok" in finished) throw new Error(finished.reason);
  }

  return { ok: true, status: signal.aborted ? "cancelled" : "completed", ...(attempted ? { workAttempted: true } : {}),
    issueId: input.issueId, grantId: input.grantId, jobId: grant.jobId,
    result: { kind: "completed", resultRefs: stageProgress(state, options.scope, source, input).resultRefs } };
}

/** Both paid findings and definitely-unsent host observations advance the
 * original native chain. Only the former can publish a method candidate. */
async function persistResearchCheckpoint(work: WorkInput, value: MethodResearchStep | MethodResearchUnsent | MethodResearchRejected) {
  const { options, input } = work, fact = methodResearchRecord(options.scope, value);
  const checkpoint = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) throw new Error(loaded.reason);
    const latest = sourceOf(loaded.state, options.scope, input.issueId);
    if (latest?.history.headRef !== value.previousRef) throw new Error("method_research_checkpoint_conflict");
    readMethodResearch({ ...loaded.state, rewardV2Facts: [...(loaded.state.rewardV2Facts ?? []), { ...fact, sequence: loaded.state.sequence + 1 }] }, options.scope, value.requestRef);
    return store.apply({ type: "record_reward_v2_fact", commandId: `rw2:${fact.id}`, issuedAt: new Date(options.now()).toISOString(), expectedSequence: loaded.state.sequence, fact });
  });
  if (!checkpoint.ok) throw new Error(checkpoint.reason);

  return fact.id;
}
