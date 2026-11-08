import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralLearningGrant, LearningDependency, LearningIssue } from "../../learning/control/coordination-contract.js";
import { centralLearningRemaining, centralLearningSpent, learningDependencyResumable } from "../../learning/control/coordination-contract.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance } from "../../learning/control/coordination-parse.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import type { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import type { CollaborationSourceAdmission } from "../../learning/agent/subsystems/collaboration/control/source-admission.js";
import { collaborationSourceCondition, type CollaborationSourceCondition } from "../../learning/agent/subsystems/collaboration/control/source-condition.js";
import type { CentralLearningContextReader, CentralLearningSourceContext } from "../../learning/control/source-context.js";
import { isCentralDecisionStageSource } from "../../learning/control/decision/stage-projection.js";
import { inspectCentralFundedStage, isCentralFundedStage } from "./funded-stage.js";
import { createCentralStageReceipts } from "./stage-receipt.js";
import { observeCentralCollaborationStage } from "./collaboration-observation.js";
import { readCentralStageContext, centralStageContextIdentity } from "./source-context.js";
import { centralStagePolicyFamily } from "./policy-family.js";
import { createCentralCollaborationResearchContextReader } from "./research-intake-collaboration.js";
import { readPreparedCentralStageContext } from "./prepared-context.js";
import { readCollaborationResearchCursors } from "../../learning/agent/subsystems/collaboration/runtime/central-research-continuation.js";
import type { CentralFundedStage, CentralLearningExecutionPort, CentralStagePreparation, CentralStagePreparationInput } from "./contracts.js";

export const CENTRAL_COLLABORATION_POLICY = "collaboration:bounded-research-and-dependency-return:v1";

export type CentralCollaborationOptions = {
  readonly boardRoot: string;
  readonly scope: string;
  readonly enabled: () => boolean;
  /** Pass the normal PA runtime's control, already mounted with createCollaborationWorker and original resource/experience ports. */
  readonly control: Pick<ReturnType<typeof createCollaborationControl>, "dispatch">
    & Partial<Pick<ReturnType<typeof createCollaborationControl>, "recoverExpired">>;
  /** Same actual host source guard used by the mounted original worker. */
  readonly admitSource?: (issue: LearningIssue) => CollaborationSourceAdmission;
  /** Original frozen host metadata, never a semantic model or value callback. */
  readonly sourceCondition?: (issue: LearningIssue) => CollaborationSourceCondition | undefined;
  readonly contextForIssue?: CentralLearningContextReader;
  /** Actual host model configuration identity; no guessed fallback for injected controls. */
  readonly modelRef?: string;
};

const unavailable = (reason: string, sourceRefs: readonly string[] = []): CentralStagePreparation => ({ status: "unavailable", reason, sourceRefs });

function stageIdentity(board: BoardState, issue: LearningIssue, grant: CentralLearningGrant | undefined,
  context: CentralLearningSourceContext | undefined, condition: CollaborationSourceCondition | undefined, modelRef: string | undefined) {
  const job = board.jobs.find(item => item.jobId === grant?.jobId);
  const dependencies = (board.learningDependencies ?? []).filter(item => item.grantId === grant?.grantId);
  const grantId = grant?.grantId ?? `collaboration-grant:${contentHashOf([issue.scope, issue.issueId,
    issue.decision.kind === "focused_learning" ? issue.decision.revision : null])}`;
  const sourceBindingRef = `collaboration-source:${contentHashOf({ scope: issue.scope, issueId: issue.issueId,
    focus: issue.decision, reports: issue.reports, centralContent: centralStageContextIdentity(context),
    condition: condition === undefined ? null : { ref: condition.ref, sourceRef: condition.sourceRef }, modelRef: modelRef ?? null })}`;
  const stageRef = `collaboration-stage:${contentHashOf({ sourceBindingRef, grantId,
    attempt: job?.attempt ?? 0, dependencies, policyRef: CENTRAL_COLLABORATION_POLICY })}`;

  return { grantId, stageRef, sourceBindingRef, dependencies, job, kind: job !== undefined && job.attempt > 0 ? "continuation" as const : "initial" as const };
}

function existingGrant(board: BoardState, issue: LearningIssue) {
  const previous = board.centralLearningGrants?.find(item => item.grantId === issue.grantId);
  return previous?.status === "closed" && issue.decision.kind === "focused_learning"
    && issue.decision.revision > previous.focusRevision ? undefined : previous;
}

const dependencyRefs = (dependencies: readonly LearningDependency[]): readonly string[] => dependencies.map(item => item.dependencyId);

/** Exact bridge to the production PA collaboration control. No worker, resource library, or purse is duplicated. */
export function createCentralCollaborationExecution(options: CentralCollaborationOptions): CentralLearningExecutionPort {
  const load = () => createBoardReader(options.boardRoot).load();
  const receipts = createCentralStageReceipts({ boardRoot: options.boardRoot, scope: options.scope, domain: "collaboration" });
  const contextForIssue = createCentralCollaborationResearchContextReader({ boardRoot: options.boardRoot, scope: options.scope,
    ...(options.contextForIssue === undefined ? {} : { fallback: options.contextForIssue }) });
  const conditionFor = (issue: LearningIssue) => options.sourceCondition?.(issue) ?? collaborationSourceCondition(issue);
  const prepare = async (input: CentralStagePreparationInput, signal: AbortSignal): Promise<CentralStagePreparation> => {
    if (signal.aborted || !options.enabled()) return unavailable("collect_disabled");

    if (!isCentralLearningGrantAllowance(input?.authorizedAllowance)) return unavailable("central_stage_authorization_invalid");

    const operation = input.operationAllowance ?? input.authorizedAllowance;
    if (!isCentralLearningAllowance(operation)) return unavailable("central_stage_operation_invalid");

    let loaded = await load();
    if (!loaded.ok) return unavailable(loaded.reason);

    let issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === options.scope);
    if (issue === undefined || learningIssueOwner(issue) !== "collaboration" || issue.decision.kind !== "focused_learning") {
      return unavailable("collaboration_focus_source_unavailable", [input.issueId]);
    }

    const admitted = options.admitSource?.(issue);
    if (admitted?.status === "rejected") return unavailable(admitted.reason, [issue.issueId]);

    const original = existingGrant(loaded.state, issue), originalJob = loaded.state.jobs.find(item => item.jobId === original?.jobId);

    // Revisit queued histories too: releasing an expired lease does not prove
    // that an earlier paid response or external resource action was recovered.
    if (original?.status === "open" && (originalJob?.state === "running" || originalJob?.state === "queued")
      && (original.claim !== undefined || originalJob.state === "running" || original.reservations.some(item =>
        item.state === "reserved" || item.usage?.kind !== "reported" || item.reservationId.startsWith("collaboration-decision:")))) {
      const recovery = await options.control.recoverExpired?.({ scope: options.scope, issueId: issue.issueId, grantId: original.grantId,
        expectedIssueRevision: issue.revision, signal });
      if (recovery === undefined) return { status: "waiting", reason: "collaboration_recovery_owner_unavailable", sourceRefs: [original.grantId] };

      if (!recovery.ok) return unavailable(recovery.reason, [original.grantId]);

      if (recovery.status === "busy" || recovery.status === "inspection") return { status: "waiting", reason: recovery.reason, sourceRefs: recovery.sourceRefs };

      loaded = await load();
      if (!loaded.ok) return unavailable(loaded.reason);

      issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === options.scope);

      if (issue === undefined || issue.decision.kind !== "focused_learning" || issue.decision.revision !== original.focusRevision
        || issue.grantId !== original.grantId) return unavailable("collaboration_recovery_source_changed", [original.grantId]);
    }

    const material = await readCentralStageContext(contextForIssue, issue.issueId);
    if (material.status !== "ready") return unavailable(material.reason, [issue.issueId]);

    const condition = conditionFor(issue);
    const grant = existingGrant(loaded.state, issue), stage = stageIdentity(loaded.state, issue, grant, material.context, condition, options.modelRef);
    const refs = [stage.sourceBindingRef, stage.stageRef];

    if (grant !== undefined) {
      if (grant.budgetId === undefined) return unavailable("central_managed_grant_required", [grant.grantId]);

      if (grant.status !== "open" || stage.job === undefined || ["succeeded", "failed", "cancelled", "expired"].includes(stage.job.state)) {
        return { status: "terminal", reason: "original_investment_terminal", sourceRefs: refs };
      }

      if (grant.focusRevision !== issue.decision.revision) return unavailable("collaboration_original_focus_changed", refs);

      if (stage.job.state === "running" || grant.claim !== undefined || grant.reservations.some(item => item.state === "reserved")) {
        return { status: "waiting", reason: "original_worker_or_reservation_pending", sourceRefs: refs };
      }

      if (stage.dependencies.some(item => ["failed", "rejected", "cancelled"].includes(item.state.kind))) {
        return { status: "terminal", reason: "original_dependency_terminal", sourceRefs: dependencyRefs(stage.dependencies) };
      }

      if (stage.job.state === "waiting_evidence" || stage.job.state === "waiting_approval"
        || stage.dependencies.some(item => !learningDependencyResumable(item))) {
        return { status: "waiting", reason: "original_dependency_waiting", sourceRefs: dependencyRefs(stage.dependencies) };
      }

      if (stage.job.state !== "queued" || stage.job.breakerOpen) {
        return { status: "terminal", reason: "original_worker_attempts_unavailable", sourceRefs: refs };
      }

      if (input.authorizedAllowance.maxPromptChars !== grant.allowance.maxPromptChars) return unavailable("original_prompt_envelope_mismatch", refs);

      if (grant.allowance.maxTokens > input.authorizedAllowance.maxTokens || grant.allowance.maxCalls > input.authorizedAllowance.maxCalls
        || grant.allowance.maxSteps > input.authorizedAllowance.maxSteps) return unavailable("collaboration_existing_envelope_exceeds_authorization", refs);
    }

    const spent = grant === undefined ? { tokens: 0, calls: 0, steps: 0 } : centralLearningSpent(grant), cap = input.authorizedAllowance;
    const future = { tokens: cap.maxTokens - spent.tokens, calls: cap.maxCalls - spent.calls, steps: cap.maxSteps - spent.steps };
    if (Object.values(future).some(value => value < 0)) return unavailable("collaboration_authorization_below_spent", refs);

    const calls = Math.min(future.calls, future.steps, operation.maxCalls, operation.maxSteps), tokens = Math.min(future.tokens, operation.maxTokens);
    const maxPromptChars = Math.min(cap.maxPromptChars, operation.maxPromptChars);
    // Returned dependencies can be assembled under the existing grant without another model reservation.
    const localReturn = grant !== undefined && stage.dependencies.length > 0 && stage.dependencies.every(learningDependencyResumable)
      && (calls === 0 || tokens === 0);
    if (!localReturn && (calls === 0 || tokens === 0)) {
      return { status: "terminal", reason: "collaboration_authorized_allowance_exhausted", sourceRefs: refs };
    }

    const reserve = localReturn ? { tokens: 0, calls: 0, steps: 0 } : { tokens, calls, steps: calls };
    const policyRef = CENTRAL_COLLABORATION_POLICY, sourceReportId = issue.reports.at(-1)!.reportId;
    const offer = { offerId: `collaboration-offer:${contentHashOf([stage.stageRef, reserve, maxPromptChars])}`,
      owner: { plane: "agent" as const, domain: "collaboration" as const }, policyRef, reserve, maxPromptChars };

    if (signal.aborted || !options.enabled()) return unavailable("collect_disabled", refs);

    const researchCursors = grant === undefined ? undefined : readCollaborationResearchCursors(loaded.state,
      { scope: options.scope, issueId: issue.issueId, grantId: grant.grantId });
    const source = { issueId: issue.issueId, grantId: stage.grantId, sourceBindingRef: stage.sourceBindingRef,
      domainStage: { stageRef: stage.stageRef, kind: stage.kind, policyRef, sourceReportId,
        readiness: { kind: "ready" as const, evidenceRefs: [...new Set([sourceReportId,
          ...(material.context === undefined ? [] : [material.context.ref]), ...dependencyRefs(stage.dependencies),
          ...(researchCursors?.kind === "continuable" ? researchCursors.cursors.map(item => item.cursorRef) : [])])] } } };

    return isCentralDecisionStageSource(source) ? { status: "ready", stageRef: stage.stageRef, policyRef, offer, authorizedAllowance: cap,
      ...(material.context === undefined ? {} : { sourceContext: { ...material.context } }),
      ...(condition === undefined ? {} : { condition }), policyFamily: centralStagePolicyFamily(policyRef, options.modelRef), source }
      : unavailable("collaboration_stage_source_capacity", refs);
  };
  const dispatchOnce = async (input: CentralFundedStage, signal: AbortSignal): Promise<FocusedLearningDispatch> => {
    if (signal.aborted || !options.enabled()) return { ok: false, reason: "collect_disabled" };

    const loaded = await load();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };

    const inspected = inspectCentralFundedStage(loaded.state, { scope: options.scope, domain: "collaboration", input });
    if (!inspected.ok) return inspected;

    const { grant, issue, job } = inspected;
    const admitted = options.admitSource?.(issue);
    if (admitted?.status === "rejected") return { ok: false, reason: admitted.reason };

    const material = await readPreparedCentralStageContext({ boardRoot: options.boardRoot, scope: options.scope,
      input, reader: contextForIssue });
    if (material.status !== "ready") return { ok: false, reason: material.reason };

    const stage = stageIdentity(loaded.state, issue, grant, material.context, conditionFor(issue), options.modelRef);
    if (input.stageRef !== stage.stageRef || input.sourceBindingRef !== stage.sourceBindingRef || input.policyRef !== CENTRAL_COLLABORATION_POLICY
      || input.offer.offerId !== `collaboration-offer:${contentHashOf([stage.stageRef, input.offer.reserve, input.offer.maxPromptChars])}`) {
      return { ok: false, reason: "collaboration_central_source_changed" };
    }

    if (grant.claim !== undefined || job.state === "running") return { ok: true, status: "busy", issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId };

    if (job.state === "waiting_evidence" || stage.dependencies.some(item => !learningDependencyResumable(item))) {
      return { ok: true, status: "waiting_dependency", issueId: issue.issueId, grantId: grant.grantId, jobId: job.jobId };
    }

    const remaining = centralLearningRemaining(grant), reserve = input.offer.reserve;
    const localReturn = reserve.tokens === 0 && reserve.calls === 0 && reserve.steps === 0
      && stage.dependencies.length > 0 && stage.dependencies.every(learningDependencyResumable)
      && (remaining.tokens === 0 || remaining.calls === 0 || remaining.steps === 0);
    const operationAllowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: reserve.tokens,
      maxCalls: reserve.calls, maxSteps: reserve.steps, maxPromptChars: input.offer.maxPromptChars };
    if (!localReturn && (!isCentralLearningAllowance(operationAllowance) || reserve.calls !== reserve.steps
      || reserve.tokens > remaining.tokens || reserve.calls > remaining.calls || reserve.steps > remaining.steps
      || input.offer.maxPromptChars > grant.allowance.maxPromptChars)) {
      return { ok: false, reason: "central_stage_envelope_changed" };
    }

    // The original controller owns claim CAS, work deadline, usage accounting, dependency waits and publication.
    return options.control.dispatch({ scope: options.scope, issueId: issue.issueId, grantId: grant.grantId,
      expectedIssueRevision: input.expectedIssueRevision,
      ...(localReturn ? {} : { operationAllowance }),
      ...(material.context === undefined ? {} : { centralSourceContext: material.context }), signal });
  };

  return { domain: "collaboration", prepare,

    async dispatch(input, signal) {
      if (!isCentralFundedStage(input)) return { ok: false, reason: "central_stage_dispatch_invalid" };

      const started = await receipts.begin(input);
      if (!started.ok) return started;

      try {
        const result = await dispatchOnce(input, signal);
        await receipts.record(input, result);
        return result;
      } catch { return { ok: false, reason: "central_stage_dispatch_unconfirmed" }; }
    },

    observe: (input, signal) => receipts.observe(input, signal, actual => observeCentralCollaborationStage({ boardRoot: options.boardRoot,
      scope: options.scope }, input, actual, signal)),
  };
}
