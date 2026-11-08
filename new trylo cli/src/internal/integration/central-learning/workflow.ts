import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { centralLearningRemaining, centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "../../learning/control/coordination-parse.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import type { CentralLearningContextReader, CentralLearningSourceContext } from "../../learning/control/source-context.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { isCentralDecisionStageSource } from "../../learning/control/decision/stage-projection.js";
import { workflowImprovementsFromBoard } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { createWorkflowImprovementFunding } from "../../learning/agent/subsystems/workflow/adapters/improvement-funding.js";
import { fileWorkflowImprovementPorts, type FileWorkflowImprovementOptions } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { workflowImprovementGrantSuffix, workflowImprovementSourceBindingRef, workflowImprovementRecordId } from "../../learning/agent/subsystems/workflow/runtime/improvement-identities.js";
import { workWorkflowImprovement } from "../../learning/agent/subsystems/workflow/runtime/improvement-worker.js";
import { WORKFLOW_IMPROVEMENT_LIMITS, type WorkflowImprovementBoardView, type WorkflowOpportunityNominationPort } from "../../learning/agent/subsystems/workflow/runtime/improvement-contracts.js";
import type { WorkflowImprovementModelPort } from "../../learning/agent/subsystems/workflow/improvement/contracts.js";
import { WORKFLOW_RESEARCH_POLICY } from "../../learning/agent/subsystems/workflow/runtime/research-state.js";
import { workflowResearchReadiness } from "../../learning/agent/subsystems/workflow/runtime/research-readiness.js";
import { workflowResearchProgressFromBoard, type WorkflowResearchProgress } from "../../learning/agent/subsystems/workflow/adapters/research-progress.js";
import { workflowFailure } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import { prepareWorkflowCentralProgram } from "../../learning/agent/subsystems/workflow/adapters/central-preparation.js";
import { workflowSourceGrants as sourceGrants, dispatchedWorkflowSourceGrant as dispatchedSource } from "../../learning/agent/subsystems/workflow/runtime/improvement-source-grants.js";
import { inspectCentralFundedStage, isCentralFundedStage } from "./funded-stage.js";
import { createCentralStageReceipts } from "./stage-receipt.js";
import { observeCentralWorkflowStage } from "./workflow-observation.js";
import { readCentralStageContext, centralStageContextIdentity } from "./source-context.js";
import { readPreparedCentralStageContext } from "./prepared-context.js";
import { centralStagePolicyFamily } from "./policy-family.js";
import type { CentralFundedStage, CentralLearningExecutionPort, CentralStagePreparation, CentralStagePreparationInput } from "./contracts.js";

export const CENTRAL_WORKFLOW_POLICY = "workflow:bounded-improvement-proposal:v1";

export type CentralWorkflowOptions = Omit<FileWorkflowImprovementOptions, "newModel" | "centralContent"> & {
  readonly enabled: () => boolean;
  /** Source nomination quotes the real host operation; it never funds a worker. */
  readonly nominationAllowance?: CentralStagePreparationInput["authorizedAllowance"];
  /** A new isolated, single-request original model whose prompt bound is this actual funded envelope. */
  readonly newModel: (maxPromptChars: number) => WorkflowImprovementModelPort;
  readonly contextForIssue?: CentralLearningContextReader;
  /** Actual host model configuration identity; absent for unknown injected models. */
  readonly modelRef?: string;
  /** Explicit compatibility for callers still supplying the v1 one-proposal model program. */
  readonly research?: boolean;
};

export type WorkflowResearchDispatch = FocusedLearningDispatch & { readonly workflowResearch?: WorkflowResearchProgress };

export type CentralWorkflowExecution = CentralLearningExecutionPort & {
  readonly queueOpportunity: WorkflowOpportunityNominationPort;
  readResearch(issueId: string): Promise<WorkflowResearchProgress | undefined>;
  dispatch(input: CentralFundedStage, signal: AbortSignal): Promise<WorkflowResearchDispatch>;
};

type Source = WorkflowImprovementBoardView["opportunities"][number] & { readonly reportId: string };

const unavailable = (reason: string, sourceRefs: readonly string[] = []): CentralStagePreparation => ({ status: "unavailable", reason, sourceRefs });
const stageRefOf = (source: Source, context: CentralLearningSourceContext | undefined, modelRef: string | undefined) => `workflow-stage:${contentHashOf({ inputVersionId: source.versionId,
  record: source.record, policyRef: CENTRAL_WORKFLOW_POLICY, centralContent: centralStageContextIdentity(context), modelRef: modelRef ?? null })}`;

function sourceBindingOf(scope: string, source: Source, context: CentralLearningSourceContext | undefined, modelRef: string | undefined): string {
  const original = workflowImprovementSourceBindingRef(scope, source.versionId);
  return context === undefined && modelRef === undefined ? original : `workflow-context-source:${contentHashOf({ original,
    centralContent: centralStageContextIdentity(context), modelRef: modelRef ?? null })}`;
}

function researchIdentity(scope: string, source: Source, context: CentralLearningSourceContext | undefined,
  modelRef: string | undefined, checkpointRef: string | undefined, attempt: number) {
  const sourceBindingRef = `workflow-research-source:${contentHashOf({ original: sourceBindingOf(scope, source, context, modelRef),
    checkpointRef: checkpointRef ?? null, attempt, policyRef: WORKFLOW_RESEARCH_POLICY })}`;
  return { sourceBindingRef, stageRef: `workflow-research-stage:${contentHashOf({ sourceBindingRef })}`, policyRef: WORKFLOW_RESEARCH_POLICY };
}

function sourceOf(issue: LearningIssue, view: WorkflowImprovementBoardView): Source | undefined {
  for (const report of [...issue.reports].reverse()) {
    if (!("subsystem" in report.source) || report.source.subsystem !== "workflow") continue;
    const versionId = report.source.versionId;
    const source = view.opportunities.find(item => item.versionId === versionId);
    if (source !== undefined) return { ...source, reportId: report.reportId };
  }
  return undefined;
}

/** These are the original selector's declared reusable keys. Instance scope,
 * problem wording and execution identifiers never become condition classes. */
function sourceCondition(source: Source): NonNullable<Extract<CentralStagePreparation, { status: "ready" }>["condition"]> {
  const { task, trigger } = source.record.opportunity, family = task.taskFamily;
  const features: JsonObject = { schema: "workflow-source-condition/v1", trigger,
    taskFamily: { id: family.id, intentClass: family.intentClass, checkKind: family.checkKind,
      language: family.language ?? null, repoKind: family.repoKind ?? null, checkSchema: family.checkSchema ?? null },
    selectorConditions: { ...task.conditions }, process: task.process === undefined ? null : { ...task.process } };
  return { ref: `workflow-condition:${contentHashOf(features)}`, sourceRef: source.versionId, features };
}

/** A managed grant enters the original one-proposal worker and original publication/adoption lineage. */
export function createCentralWorkflowExecution(options: CentralWorkflowOptions): CentralWorkflowExecution {
  const scope = options.centralScope ?? options.scope;
  const load = () => createBoardReader(options.boardRoot).load();
  const receipts = createCentralStageReceipts({ boardRoot: options.boardRoot, scope, domain: "workflow" });
  const research = options.research ?? options.newModel(WORKFLOW_IMPROVEMENT_LIMITS.maxPromptChars).research !== undefined;
  const readResearch = async (issueId: string) => {
    const loaded = await load();
    return !loaded.ok ? undefined : workflowResearchProgressFromBoard(loaded.state, { scope: options.scope, centralScope: scope, issueId });
  };
  // Nomination preserves the original source; central allocation owns any later dispatch.
  const queueOpportunity: WorkflowOpportunityNominationPort = async (record, signal) => {
    if (signal.aborted || !options.enabled()) return workflowFailure("cancelled", "Central nomination is unavailable");

    if (!options.publicData(record)) return workflowFailure("workflow_private_report", "Private workflow material cannot be nominated");

    const loaded = await load();
    if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

    const inputVersionId = workflowImprovementRecordId(record), history = sourceGrants(loaded.state, scope, inputVersionId);
    const sent = dispatchedSource(history);
    if (sent !== undefined && (!research || sent.status === "closed")) return workflowFailure("workflow_explicit_grant_required", "A sent source needs confirmed continuation on its original open research grant");

    if (history.length > 1) return workflowFailure("workflow_source_has_multiple_grants", "Original source ownership is ambiguous");

    const previous = history[0], issue = loaded.state.learningIssues?.find(item => item.issueId === previous?.issueId);
    if (previous !== undefined && (previous.budgetId === undefined || issue?.decision.kind !== "focused_learning"
      || issue.grantId !== previous.grantId)) return workflowFailure("workflow_original_grant_unavailable", "Original source ownership must be reconciled before nomination");

    const existingIssue = loaded.state.learningIssues?.find(item => item.scope === scope && item.reports.some(report =>
      "subsystem" in report.source && report.source.subsystem === "workflow" && report.source.versionId === inputVersionId));
    const prepared = previous === undefined ? await createWorkflowImprovementFunding({ ...options, research,
      preparation: { kind: "central_source", ...(options.nominationAllowance === undefined ? {} : { allowance: options.nominationAllowance }), ...(existingIssue === undefined ? {} : {
        expectedIssue: { issueId: existingIssue.issueId, revision: existingIssue.revision } }) } }).prepare(record)
      : { ok: true as const, value: { issueId: previous.issueId, inputVersionId,
        sourceBindingRef: workflowImprovementSourceBindingRef(scope, inputVersionId) } };
    if (!prepared.ok) return prepared;

    if (signal.aborted || !options.enabled()) return workflowFailure("cancelled", "Nomination ended after preserving its actual source");

    return { ok: true, value: { status: "queued_for_central", issueId: prepared.value.issueId,
      inputVersionId, sourceBindingRef: prepared.value.sourceBindingRef,
      note: "The original source is saved. Central allocation owns any later investment; this receipt is not a grant or running worker." } };
  };
  const prepare = async (input: CentralStagePreparationInput, signal: AbortSignal): Promise<CentralStagePreparation> => {
    if (signal.aborted || !options.enabled()) return unavailable("collect_disabled");

    if (!isCentralLearningGrantAllowance(input?.authorizedAllowance)
      || !isCentralLearningAllowance(input.operationAllowance ?? input.authorizedAllowance)) return unavailable("central_stage_authorization_invalid");

    const operation = input.operationAllowance ?? input.authorizedAllowance;
    const loaded = await load();
    if (!loaded.ok) return unavailable(loaded.reason);

    const issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === scope);
    if (issue === undefined || learningIssueOwner(issue) !== "workflow" || issue.decision.kind !== "focused_learning") {
      return unavailable("workflow_focus_source_unavailable", [input.issueId]);
    }

    const view = workflowImprovementsFromBoard(loaded.state, options.scope, scope);
    if (!view.ok) return unavailable(view.code, [issue.issueId]);

    const source = sourceOf(issue, view.value);
    if (source === undefined) return unavailable("workflow_focus_source_unavailable", [issue.issueId]);

    const material = await readCentralStageContext(options.contextForIssue, issue.issueId);
    if (material.status !== "ready") return unavailable(material.reason, [source.versionId]);

    const centralContent = material.context;
    const history = sourceGrants(loaded.state, scope, source.versionId);
    // A new host run/budget ID cannot turn the same already-sent input into a fresh proposal.
    const dispatched = dispatchedSource(history);
    if (dispatched !== undefined && (!research || dispatched.status === "closed")) {
      return { status: "terminal", reason: "workflow_source_already_dispatched", sourceRefs: [source.versionId, dispatched.grantId] };
    }

    if (history.length > 1) return unavailable("workflow_source_has_multiple_grants", [source.versionId]);

    const original = history[0];
    if (original !== undefined && (original.budgetId === undefined || issue.grantId !== original.grantId
      || original.focusRevision !== issue.decision.revision)) return unavailable("workflow_original_grant_unavailable", [original.grantId]);

    // Original preparation owns new grant identity/run allowance. An existing unsent managed grant keeps its original identity across runs.
    const prepared = original === undefined ? await createWorkflowImprovementFunding({ ...options, research,
      preparation: { kind: "central_source", allowance: input.authorizedAllowance,
        expectedIssue: { issueId: issue.issueId, revision: issue.revision } } }).prepare(source.record)
      : { ok: true as const, value: { issueId: issue.issueId, grantId: original.grantId,
        sourceBindingRef: workflowImprovementSourceBindingRef(scope, source.versionId), allowance: original.allowance } };
    if (!prepared.ok) return unavailable(prepared.code, [source.versionId]);

    if (prepared.value.issueId !== issue.issueId) return unavailable("workflow_canonical_issue_mismatch", [source.versionId]);

    if (signal.aborted || !options.enabled()) return unavailable("collect_disabled", [source.versionId]);

    const current = await load();
    if (!current.ok) return unavailable(current.reason, [source.versionId]);

    const grant = current.state.centralLearningGrants?.find(item => item.grantId === prepared.value.grantId);
    const job = current.state.jobs.find(item => item.jobId === grant?.jobId);
    if (!research && grant !== undefined && (grant.status !== "open" || job?.state !== "queued" || job.attempt !== 0 || grant.reservations.length !== 0)) {
      return { status: job?.state === "running" ? "waiting" : "terminal", reason: "workflow_requires_fresh_unsent_proposal", sourceRefs: [source.versionId, grant.grantId] };
    }

    if (research && grant !== undefined && (grant.status !== "open" || job === undefined || !["queued", "running"].includes(job.state))) {
      return { status: "terminal", reason: "workflow_research_original_grant_terminal", sourceRefs: [source.versionId, grant.grantId] };
    }

    const progress = research ? workflowResearchReadiness(view.value, source.versionId, grant, options.now()) : undefined;
    if (progress !== undefined && progress.status !== "ready") return { ...progress, sourceRefs: [source.versionId] };

    const localPublication = progress?.status === "ready" && progress.localPublication;
    const spent = grant === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(grant);
    const authorizedAllowance = localPublication && grant !== undefined ? grant.allowance : { ...input.authorizedAllowance,
      maxTokens: research ? Math.min(input.authorizedAllowance.maxTokens, spent.tokens + operation.maxTokens)
        : Math.min(input.authorizedAllowance.maxTokens, operation.maxTokens, prepared.value.allowance.maxTokens),
      maxCalls: research ? Math.min(input.authorizedAllowance.maxCalls, spent.calls + operation.maxCalls) : 1,
      maxSteps: research ? Math.min(input.authorizedAllowance.maxSteps, spent.steps + operation.maxSteps) : 1,
      maxPromptChars: input.authorizedAllowance.maxPromptChars };
    const stageMaxPromptChars = Math.min(authorizedAllowance.maxPromptChars, operation.maxPromptChars);
    if (!research && grant !== undefined && stageMaxPromptChars !== grant.allowance.maxPromptChars) {
      return unavailable("workflow_v1_operation_prompt_requires_original_envelope", [grant.grantId]);
    }

    if (!localPublication && grant !== undefined && (grant.allowance.maxTokens > authorizedAllowance.maxTokens
      || !research && (grant.allowance.maxCalls !== 1 || grant.allowance.maxSteps !== 1)
      || !research && grant.allowance.maxPromptChars !== authorizedAllowance.maxPromptChars)) {
      return unavailable("workflow_existing_envelope_exceeds_authorization", [grant.grantId]);
    }

    const future = localPublication ? { tokens: 0, calls: 0, steps: 0 }
      : { tokens: authorizedAllowance.maxTokens - spent.tokens, calls: authorizedAllowance.maxCalls - spent.calls,
        steps: authorizedAllowance.maxSteps - spent.steps };
    if (Object.values(future).some(value => value < 0)) return unavailable("workflow_authorization_below_spent", [source.versionId]);

    const feasible = progress?.status === "ready" && progress.localPublication ? { ok: true as const, value: { contextRef: progress.head!.record.contextRef } }
      : await prepareWorkflowCentralProgram({ store: fileWorkflowImprovementPorts(options).store,
      record: source.record, allowance: research ? future.tokens : grant?.allowance.maxTokens ?? authorizedAllowance.maxTokens,
      maxPromptChars: stageMaxPromptChars, publicData: options.publicData,
      ...(options.contextPublicData === undefined ? {} : { contextPublicData: options.contextPublicData }),
      ...(progress?.status === "ready" ? { research: { observations: progress.observations, records: progress.records } } : {}),
      ...(centralContent === undefined ? {} : { centralContent }) });
    if (!feasible.ok) return unavailable(feasible.code, [source.versionId]);

    if (signal.aborted || !options.enabled()) return unavailable("collect_disabled", [source.versionId]);

    if (progress?.status === "ready" && progress.head?.record.status === "waiting_evidence"
      && progress.head.record.contextRef === feasible.value.contextRef) return { status: "waiting",
        reason: "workflow_research_external_evidence_required", sourceRefs: [source.versionId, progress.head.versionId] };

    const identity = research ? researchIdentity(scope, source, centralContent, options.modelRef, progress?.status === "ready" ? progress.head?.versionId : undefined, job?.attempt ?? 0)
      : { stageRef: stageRefOf(source, centralContent, options.modelRef), policyRef: CENTRAL_WORKFLOW_POLICY,
        sourceBindingRef: sourceBindingOf(scope, source, centralContent, options.modelRef) };
    const { stageRef, policyRef } = identity;
    const offer = { offerId: `workflow-offer:${contentHashOf([stageRef, authorizedAllowance])}`,
      owner: { plane: "agent" as const, domain: "workflow" as const }, policyRef,
      reserve: research ? future : { tokens: grant?.allowance.maxTokens ?? authorizedAllowance.maxTokens, calls: 1, steps: 1 },
      maxPromptChars: stageMaxPromptChars };
    const stageSource = { issueId: issue.issueId, grantId: prepared.value.grantId, sourceBindingRef: identity.sourceBindingRef,
      domainStage: { stageRef, kind: research && grant !== undefined && grant.reservations.length > 0 ? "continuation" as const : "initial" as const, policyRef, sourceReportId: source.reportId,
        readiness: { kind: "ready" as const, evidenceRefs: [...new Set([source.versionId, feasible.value.contextRef,
          ...(progress?.status === "ready" && progress.head !== undefined ? [progress.head.versionId] : []),
          ...(centralContent === undefined ? [] : [centralContent.ref])])] } } };

    return isCentralDecisionStageSource(stageSource) ? { status: "ready", stageRef, policyRef, offer, authorizedAllowance,
      ...(centralContent === undefined ? {} : { sourceContext: centralContent }),
      condition: sourceCondition(source), policyFamily: centralStagePolicyFamily(policyRef, options.modelRef), source: stageSource }
      : unavailable("workflow_stage_source_capacity", [source.versionId]);
  };
  const dispatchOnce = async (input: CentralFundedStage, signal: AbortSignal): Promise<FocusedLearningDispatch> => {
    if (signal.aborted || !options.enabled()) return { ok: false, reason: "collect_disabled" };

    const loaded = await load();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };

    const inspected = inspectCentralFundedStage(loaded.state, { scope, domain: "workflow", input });
    if (!inspected.ok) return inspected;

    const { issue, grant, job } = inspected;

    if (!research && (grant.claim !== undefined || job.state === "running")) return { ok: true, status: "busy", issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId };

    if (!research && (job.state !== "queued" || job.attempt !== 0 || grant.reservations.length !== 0)) return { ok: false, reason: "workflow_requires_fresh_unsent_proposal" };

    const view = workflowImprovementsFromBoard(loaded.state, options.scope, scope);
    if (!view.ok) return { ok: false, reason: view.code };

    const source = sourceOf(issue, view.value);
    const material = await readPreparedCentralStageContext({ boardRoot: options.boardRoot, scope, input,
      ...(options.contextForIssue === undefined ? {} : { reader: options.contextForIssue }) });
    if (material.status !== "ready") return { ok: false, reason: material.reason };

    const centralContent = material.context;

    if (source === undefined) return { ok: false, reason: "workflow_central_source_changed" };

    const progress = research ? workflowResearchReadiness(view.value, source.versionId, grant, options.now()) : undefined;
    if (progress !== undefined && progress.status !== "ready") return { ok: false, reason: progress.reason };

    const identity = research ? researchIdentity(scope, source, centralContent, options.modelRef, progress?.status === "ready" ? progress.head?.versionId : undefined, job.attempt)
      : { stageRef: stageRefOf(source, centralContent, options.modelRef), policyRef: CENTRAL_WORKFLOW_POLICY,
        sourceBindingRef: sourceBindingOf(scope, source, centralContent, options.modelRef) };
    const remaining = centralLearningRemaining(grant), reserve = input.offer.reserve;
    if (input.stageRef !== identity.stageRef || input.policyRef !== identity.policyRef
      || input.sourceBindingRef !== identity.sourceBindingRef
      || !grant.grantId.endsWith(workflowImprovementGrantSuffix(source.versionId))
      || !research && input.offer.maxPromptChars !== grant.allowance.maxPromptChars
      || research && input.offer.maxPromptChars > grant.allowance.maxPromptChars
      || !research && (reserve.tokens !== grant.allowance.maxTokens || reserve.calls !== 1 || reserve.steps !== 1)
      || research && progress?.status === "ready" && !progress.localPublication
        && (reserve.calls < 1 || reserve.steps < 1
          || reserve.tokens > remaining.tokens || reserve.calls > remaining.calls || reserve.steps > remaining.steps)) {
      return { ok: false, reason: "workflow_central_source_changed" };
    }

    const ports = fileWorkflowImprovementPorts(options);
    const funding = createWorkflowImprovementFunding({ ...options, research, binding: { grantId: grant.grantId,
      inputVersionId: source.versionId, expectedIssueRevision: input.expectedIssueRevision,
      ...(!research || progress?.status === "ready" && progress.localPublication ? {} : { stage: {
        chargedAtStart: centralLearningSpent(grant), allowance: { schemaVersion: 2, unit: "total_model_tokens",
          maxTokens: reserve.tokens, maxCalls: reserve.calls, maxSteps: reserve.steps, maxPromptChars: input.offer.maxPromptChars } } }) } });
    const funded = { grantId: grant.grantId, jobId: job.jobId, inputVersionId: source.versionId, state: "queued" as const, resultRefs: [] };
    const result = await workWorkflowImprovement({ ...options, ...ports, funding: { ...funding,
      reserve: value => !options.enabled() || signal.aborted ? Promise.resolve({ ok: false as const,
        code: "cancelled", message: "Central workflow collection or dispatch was withdrawn" }) : funding.reserve(value) },
      newModel: () => options.newModel(input.offer.maxPromptChars),
      ...(centralContent === undefined ? {} : { centralContent }),
      publicData: value => options.enabled() && options.publicData(value) }, funded, source.record, signal);
    const after = await load();
    if (!after.ok) return { ok: false, reason: after.reason, workAttempted: true };

    const finalGrant = after.state.centralLearningGrants?.find(item => item.grantId === grant.grantId);
    const finalJob = after.state.jobs.find(item => item.jobId === job.jobId);

    if (result.ok && !("versionId" in result.value)) return { ok: true, status: result.value.status === "waiting_evidence" ? "waiting_dependency" : "idle",
      workAttempted: true, issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId,
      ...(finalGrant === undefined ? {} : { remaining: centralLearningRemaining(finalGrant) }) };

    if (result.ok && "versionId" in result.value && finalJob?.state === "succeeded") return { ok: true, status: "completed", workAttempted: true,
      issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId,
      ...(finalGrant === undefined ? {} : { remaining: centralLearningRemaining(finalGrant) }),
      result: { kind: "completed", resultRefs: finalJob.coordination?.resultRefs ?? [result.value.versionId] } };

    if (finalJob?.state === "cancelled" || finalJob?.state === "failed") return { ok: true, status: finalJob.state, workAttempted: true,
      issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId,
      result: { kind: finalJob.state, reason: finalGrant?.closedReason ?? (result.ok ? "workflow_outcome_conflict" : result.code) } };

    return { ok: false, reason: result.ok ? "workflow_outcome_not_confirmed" : result.code, workAttempted: true };
  };

  return { domain: "workflow", prepare, queueOpportunity, readResearch,

    async dispatch(input, signal) {
      if (!isCentralFundedStage(input)) return { ok: false, reason: "central_stage_dispatch_invalid" };

      const started = await receipts.begin(input);
      if (!started.ok) return started;

      try {
        const result = await dispatchOnce(input, signal);
        await receipts.record(input, result);
        const progress = research ? await readResearch(input.issueId) : undefined;
        return progress === undefined ? result : { ...result, workflowResearch: progress };
      } catch { return { ok: false, reason: "central_stage_dispatch_unconfirmed" }; }
    },

    observe: (input, signal) => receipts.observe(input, signal, async actual => {
      const progress = research ? await readResearch(input.issueId) : undefined;
      if (actual.workAttempted === true && actual.ok && progress !== undefined && actual.status !== "completed"
        && progress.handback.kind !== "inspection_required" && progress.handback.kind !== "in_flight") {
        return { outcome: "closed_no_result" as const, resultRefs: [], sourceRefs: progress.sourceRefs,
          reason: "workflow_research_segment_handed_back_without_proposal_not_goal_completion" };
      }

      return observeCentralWorkflowStage({ boardRoot: options.boardRoot, scope: options.scope, centralScope: scope }, input, actual, signal);
    }),
  };
}
