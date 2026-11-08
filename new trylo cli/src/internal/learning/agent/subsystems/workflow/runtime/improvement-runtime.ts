import { contentHashOf } from "../../../../control/hash.js";
import { workflowConditionKey } from "../domain/family.js";
import { record, text, workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import type { WorkflowImprovementFeedback } from "../improvement/contracts.js";
import { compileWorkflowImprovement, parseWorkflowImprovementFeedback, parseWorkflowOpportunity, parseWorkflowProcessTask, workflowImprovementReputation, workflowProcessMatches, workflowImprovementEditScope } from "../improvement/index.js";
import { latestWorkflowImprovement, selectWorkflowImprovement, workflowImprovementHeads } from "./improvement-selection.js";
import { workWorkflowImprovement } from "./improvement-worker.js";
import type { WorkflowImprovementRuntimeOptions, WorkflowImprovementFunding, WorkflowImprovementOpportunityRecord, WorkflowImprovementDispatchPolicy } from "./improvement-contracts.js";
import { workflowSettlementWithin } from "./improvement-cancellation.js";
import { projectWorkflowImprovementFeedback } from "./improvement-feedback-evidence.js";
import { workflowCorrectionAllows } from "./improvement-lineage.js";
import { bindWorkflowProcessEvidence } from "./improvement-process-evidence.js";
import { boundWorkflowImprovementInventory } from "./improvement-inventory.js";

/** A model hook nominates work. Central funding, background work and boundary adoption remain separate. */
export function createWorkflowImprovementRuntime(options: WorkflowImprovementRuntimeOptions) {
  const funding = options.funding;
  const workers = new Map<string, { readonly abort: AbortController; readonly done: Promise<void>; readonly funded: WorkflowImprovementFunding }>();
  const unsettled = new Map<string, WorkflowImprovementFunding>();
  let state: "open" | "closed" = "open";
  const isOpen = () => state === "open";
  const lifetime = new AbortController();
  const operationSignal = (callSignal?: AbortSignal) => callSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, callSignal]);
  const at = () => new Date(options.now()).toISOString();
  const stopFunded = async (funded: WorkflowImprovementFunding) => {
    let result: WorkflowLearningResult<unknown>;
    try { result = await funding.stop(funded); }
    catch { result = workflowFailure("workflow_settlement_unavailable", "The central cancellation boundary was unavailable"); }
    if (result.ok) unsettled.delete(funded.jobId);
    else unsettled.set(funded.jobId, funded);
    return result;
  };
  const data = async () => {
    const [view, observed] = await Promise.all([options.store.read(), options.readEvidence()]);

    if (!view.ok) return view;

    if (!observed.ok) return observed;

    const feedback = projectWorkflowImprovementFeedback(view.value.feedback);
    const hostEvidence = (options.hostEvidence ?? []).filter(item => item.sourceVersionId === undefined
      || view.value.sourceVisibility?.[item.sourceVersionId] === "available");

    return feedback.ok ? { ok: true as const, value: { view: view.value, observed: observed.value,
      evidence: [...observed.value.evidence, ...feedback.value, ...hostEvidence] } } : feedback;
  };
  const launch = async (input: WorkflowImprovementOpportunityRecord, signal: AbortSignal): Promise<WorkflowLearningResult<unknown>> => {
    if (signal.aborted) return workflowFailure("cancelled", "The nomination was cancelled before funding");

    if (options.nominateOpportunity !== undefined) return options.nominateOpportunity(input, signal);

    const funded = await funding.fund(input);
    if (!funded.ok) return funded;

    if (funded.value.state === "existing" && options.funding.research === undefined) return { ok: true, value: { status: "existing", ...funded.value } };

    if (funded.value.state === "existing" && options.funding.research !== undefined) {
      const current = await options.funding.research.inspect(funded.value);
      if (!current.ok) return current;
      if (current.value.state === "running" && current.value.activeClaim !== undefined
        && Date.parse(current.value.activeClaim.expiresAt) > options.now()) return { ok: true, value: { ...funded.value, status: "busy" } };
    }

    if (!isOpen() || signal.aborted) {
      const stopped = await stopFunded(funded.value);
      return stopped.ok ? workflowFailure("cancelled", "The run closed before its queued researcher could start") : stopped;
    }

    const abort = new AbortController();
    // The terminal catch persists cancellation and reports a degradation; it never creates a success.
    const done = workWorkflowImprovement(options, funded.value, input, abort.signal).then(async result => {
      if (!result.ok) {
        const stopped = await stopFunded(funded.value);
        options.warn(stopped.ok ? result.code : stopped.code);
      }
    }).catch(async () => {
      const stopped = await stopFunded(funded.value);
      options.warn(stopped.ok ? "workflow_worker_unavailable" : stopped.code);
    }).finally(() => { workers.delete(funded.value.jobId); });

    workers.set(funded.value.jobId, { abort, done, funded: funded.value });

    return { ok: true, value: { status: "queued", jobId: funded.value.jobId, grantId: funded.value.grantId,
      inputVersionId: funded.value.inputVersionId, note: "Business continues. Obtain context at a later phase boundary; a proposal is not a verified improvement." } };
  };

  return {
    async opportunity(callId: string, raw: unknown, callSignal?: AbortSignal): Promise<WorkflowLearningResult<unknown>> {
      const signal = operationSignal(callSignal);

      if (callSignal?.aborted) return workflowFailure("cancelled", "The nomination was cancelled");

      if (!isOpen()) return workflowFailure("workflow_runtime_closed", "Workflow learning ended at the run boundary");

      if (!record(raw) || !options.publicData(raw)) return workflowFailure("invalid_workflow_opportunity", "A public, structured opportunity is required");

      if (text(raw.resumeOpportunityId) && Object.keys(raw).length === 1) {
        const current = await data();
        if (!current.ok) return current;

        if (callSignal?.aborted) return workflowFailure("cancelled", "The nomination was cancelled during its read");

        if (!isOpen()) return workflowFailure("workflow_runtime_closed", "The run closed before resuming its saved opportunity");

        const previous = current.value.view.opportunities.find(item => item.versionId === raw.resumeOpportunityId);
        if (previous === undefined) return workflowFailure("workflow_improvement_not_found", "Only an available saved opportunity may resume");

        const parent = latestWorkflowImprovement(current.value.view.versions, previous.record.opportunity);
        if (parent?.versionId !== previous.record.parentVersionId) return workflowFailure("workflow_resume_stale_parent", "New facts must nominate the current revision rather than replay an old parent");

        if (!workflowCorrectionAllows(current.value.view.versions, current.value.view.opportunities, previous.record.opportunity, previous.record.parentVersionId)) {
          return workflowFailure("workflow_correction_pending", "A later correction owns this process revision");
        }

        if (options.nominateOpportunity !== undefined) return launch(previous.record, signal);

        const resumed = await funding.prepareResume(previous.versionId);

        return resumed.ok ? launch(previous.record, signal) : resumed;
      }

      if (!record(raw.task) || Object.keys(raw).some(key => !["opportunityId", "issueKey", "task", "trigger", "problem", "desiredOutcome", "evidenceRefs", "affectedStepIds"].includes(key))) {
        return workflowFailure("invalid_workflow_opportunity", "Nomination accepts only a problem, task premises, trigger, desired outcome and actual evidence refs");
      }

      const parsed = parseWorkflowOpportunity({ ...raw, opportunityId: `workflow-opportunity:${contentHashOf([options.sessionId, callId])}`,
        task: { ...raw.task, scope: options.scope } });
      if (!parsed.ok) return parsed;

      if (parsed.value.trigger === "central_research") return workflowFailure("workflow_central_research_requires_native_receiver",
        "A central research purpose must enter through its grounded native receiver, not a business model's claimed trigger");

      const current = await data();
      if (!current.ok) return current;

      if (callSignal?.aborted) return workflowFailure("cancelled", "The nomination was cancelled during its read");

      if (!isOpen()) return workflowFailure("workflow_runtime_closed", "The run closed before funding its nomination");

      const opportunity = { ...parsed.value, opportunityId: `workflow-opportunity:${contentHashOf([
        options.sessionId, current.value.observed.executionId, callId])}` };
      const byRef = new Map(current.value.evidence.map(item => [item.ref, item]));
      if (opportunity.evidenceRefs.some(ref => !byRef.has(ref))) return workflowFailure("workflow_evidence_unavailable", "Nomination must cite current host-projected evidence");

      const previous = current.value.view.opportunities.filter(item => workflowProcessMatches(item.record.opportunity.task, opportunity.task)
        && workflowConditionKey(item.record.opportunity.task.conditions) === workflowConditionKey(opportunity.task.conditions));
      if (previous.some(item => item.record.opportunity.opportunityId !== opportunity.opportunityId
        && opportunity.evidenceRefs.every(ref => item.record.opportunity.evidenceRefs.includes(ref)))) {
        return workflowFailure("workflow_new_evidence_required", "The same evidence cannot fund another renamed learning attempt");
      }

      const source = opportunity.evidenceRefs.map(ref => byRef.get(ref)!);

      if (current.value.view.feedback.some(item => opportunity.evidenceRefs.includes(item.feedbackId) && !workflowProcessMatches(item.task, opportunity.task))) {
        return workflowFailure("workflow_evidence_context_mismatch", "A feedback observation belongs to a different process contract");
      }

      if (opportunity.trigger === "user_correction" && !source.some(item => item.kind === "user_input" || item.kind === "user_correction")
        || opportunity.trigger === "repeated_inefficiency" && source.filter(item => !["context", "user_input"].includes(item.kind)).length < 2) {
        return workflowFailure("improvement_trigger_unsupported", "The nomination trigger needs actual user input or repeated execution evidence");
      }

      const parent = latestWorkflowImprovement(current.value.view.versions, opportunity);

      if (opportunity.affectedStepIds !== undefined) {
        const edit = workflowImprovementEditScope(parent?.artifact, opportunity.affectedStepIds);
        if (!edit.ok) return edit;
      }

      const parentRefs = parent === undefined ? new Set<string>() : new Set([
        ...parent.artifact.proposal.diagnosis.supportingRefs, ...parent.artifact.proposal.diagnosis.counterEvidenceRefs,
        ...parent.artifact.proposal.changes.flatMap(item => item.evidenceRefs),
      ]);
      const evidence = [...new Map([...(parent?.artifact.evidence.filter(item => parentRefs.has(item.ref) || item.kind === "user_correction")
        .map(item => ({ ...item, sourceVersionId: item.sourceVersionId ?? parent.versionId })) ?? []),
        ...source].map(item => [item.ref, item])).values()];
      const input: WorkflowImprovementOpportunityRecord = { type: "workflow_improvement_opportunity", schemaVersion: 1, opportunity,
        evidence, ...(parent === undefined ? {} : { parentVersionId: parent.versionId }) };
      if (opportunity.trigger !== "user_correction" && !workflowCorrectionAllows(current.value.view.versions, current.value.view.opportunities, opportunity, input.parentVersionId)) {
        return workflowFailure("workflow_correction_pending", "Resume or incorporate the outstanding correction before learning an older plan");
      }

      return launch(input, signal);
    },
    async context(callId: string, raw: unknown, callSignal?: AbortSignal): Promise<WorkflowLearningResult<unknown>> {
      const signal = operationSignal(callSignal);

      if (callSignal?.aborted) return workflowFailure("cancelled", "The handoff was cancelled");

      if (!record(raw) || !options.publicData(raw)) return workflowFailure("invalid_workflow_context", "Public context arguments are required");

      if (!isOpen() && raw.task !== undefined) return workflowFailure("workflow_runtime_closed", "Closed runs cannot adopt another procedure");

      const current = await data();
      if (!current.ok) return current;

      if (callSignal?.aborted) return workflowFailure("cancelled", "The handoff was cancelled during its read");

      const available = workflowImprovementHeads(current.value.view).slice(-8).map(item => ({ versionId: item.versionId,
        issueKey: item.artifact.opportunity.issueKey, task: item.artifact.opportunity.task, name: item.artifact.proposal.procedure.name, status: item.status,
        stepIds: item.artifact.proposal.procedure.steps.map(step => step.id),
        requiredConditions: item.artifact.proposal.procedure.requiredConditions,
        ...(item.artifact.opportunity.trigger !== "central_research" ? {} : { researchTarget: {
          purpose: item.artifact.opportunity.desiredOutcome, sourceRefs: item.artifact.opportunity.evidenceRefs,
          standing: "proposed_not_observed_business_task" as const,
        } }),
        reputation: workflowImprovementReputation(item.artifact, current.value.view.feedback, item.versionId, item.artifact.opportunity.task) }));
      const inventory = boundWorkflowImprovementInventory({ available, recentIssues: current.value.view.recentIssues,
        evidence: current.value.evidence,
        uses: current.value.view.uses.filter(item => item.sessionId === options.sessionId).slice(-8).map(item => item.use) });

      if (raw.task === undefined) return { ok: true, value: { status: "inventory", ...inventory,
        researchTargetMeaning: "A research target describes an intended use, not an observed business task. Adopt only when the current intent, input/output, effects and check contract match; probe unknown assumptions before reuse. Inventory identifiers do not establish current task facts.",
        issueStatusMeaning: "Proposal job states describe research engineering, never whether using the procedure helped. Reuse issueKey; unknown or paid failed research needs new evidence or an explicit operator grant." } };

      if (!record(raw.task) || !text(raw.boundary) || raw.boundary.length > 512
        || raw.versionId !== undefined && !text(raw.versionId) || raw.issueKey !== undefined && !text(raw.issueKey)) {
        return workflowFailure("invalid_workflow_context", "Adoption requires current task premises and an explicit phase boundary");
      }

      const task = parseWorkflowProcessTask({ ...raw.task, scope: options.scope });
      if (!task.ok) return task;

      if (!isOpen()) return workflowFailure("workflow_runtime_closed", "The run closed before adopting a procedure");

      const policy = options.dispatchPolicy?.(task.value, current.value.view.sourceVisibility);
      if (policy !== undefined && !policy.ok) return policy;

      if (policy?.ok && policy.value.kind === "deferred") return { ok: true, value: { status: "handoff_deferred", ...policy.value,
        note: "Continue the current business task; proposed improvements remain available for a later compatible handoff." } };

      const selected = selectWorkflowImprovement(current.value.view, task.value, {
        ...(typeof raw.versionId === "string" ? { versionId: raw.versionId } : {}), ...(typeof raw.issueKey === "string" ? { issueKey: raw.issueKey } : {}) });
      if (selected === undefined) return { ok: true, value: { status: "not_applicable", ...inventory,
        applicability: workflowImprovementHeads(current.value.view).filter(item =>
          (raw.versionId === undefined || item.versionId === raw.versionId)
          && (raw.issueKey === undefined || item.artifact.opportunity.issueKey === raw.issueKey)).slice(-4).map(item => {
            const unmet = Object.entries(item.artifact.proposal.procedure.requiredConditions)
              .filter(([key, value]) => task.value.conditions?.[key] !== value);
            return { versionId: item.versionId, status: item.status, processContractMatches: workflowProcessMatches(item.artifact.opportunity.task, task.value),
              unmetConditions: unmet.slice(0, 8).map(([key]) => ({ key, reason: task.value.conditions?.[key] === undefined ? "missing" : "different" })),
              omittedConditions: Math.max(0, unmet.length - 8) };
          }),
        note: "No latest applicable workflow is ready. The listed process/required-condition mismatches explain applicability only, not permission or quality. Additional observed facts do not invalidate an otherwise matching procedure. Continue ordinary work; probe unknown premises and use real new mismatch evidence for a revision." } };

      const reputation = workflowImprovementReputation(selected.artifact, current.value.view.feedback, selected.versionId, task.value);
      const compiled = compileWorkflowImprovement(selected.artifact, task.value, undefined, reputation);
      if (!compiled.ok) return compiled;

      // The store rechecks current governance atomically. A subsystem-local
      // constant must not turn a complete eligible procedure into unusable work.
      const revalidate: WorkflowImprovementDispatchPolicy | undefined = options.dispatchPolicy;
      const use = { useId: `workflow-use:${contentHashOf([options.sessionId, current.value.observed.executionId,
        current.value.observed.watermark, callId, selected.versionId, task.value, raw.boundary])}`,
        versionId: selected.versionId, task: task.value, boundary: raw.boundary };
      const saved = await options.store.adopt({ type: "workflow_improvement_use", schemaVersion: 1,
        use, sessionId: options.sessionId, afterSequence: current.value.observed.watermark }, at(), signal, revalidate);

      if (callSignal?.aborted) return workflowFailure("cancelled", "The handoff was cancelled; inspect any already committed use");

      if (!isOpen()) return workflowFailure("workflow_runtime_closed", "The run closed before guidance could be fielded; inspect any committed use record");

      if (!saved.ok) return saved;

      if (revalidate !== undefined && saved.value.dispatchChecked !== true) return workflowFailure("workflow_improvement_dispatch_unchecked", "The store did not acknowledge current host governance");

      const guidance = [compiled.value, saved.value.hostGuidance].filter(Boolean).join("\n");

      return saved.ok ? { ok: true, value: { status: "frozen", use: { useId: use.useId, versionId: use.versionId, boundary: use.boundary }, guidance, reputation,
        ...(selected.fallbackFromVersionId === undefined ? {} : { fallbackFromVersionId: selected.fallbackFromVersionId }),
        note: "Use from this handoff only. Check assumptions, retain current user instructions, and report actual post-use receipts. Adoption does not prove following or benefit." } } : saved;
    },
    async feedback(callId: string, raw: unknown, callSignal?: AbortSignal): Promise<WorkflowLearningResult<unknown>> {
      const signal = operationSignal(callSignal);

      if (callSignal?.aborted) return workflowFailure("cancelled", "The feedback was cancelled");

      if (!isOpen()) return workflowFailure("workflow_runtime_closed", "Closed runs accept no model feedback");

      if (!record(raw) || !options.publicData(raw) || Object.keys(raw).some(key => !["useId", "exposure", "evidenceRefs", "followedStepIds", "explanation"].includes(key)) || !text(raw.useId)
        || raw.evidenceRefs !== undefined && (!Array.isArray(raw.evidenceRefs) || !raw.evidenceRefs.every(text)) || !Array.isArray(raw.followedStepIds)
        || !raw.followedStepIds.every(text) || !text(raw.explanation) || !["reported_used", "skipped"].includes(String(raw.exposure))) {
        return workflowFailure("invalid_workflow_feedback", "Feedback needs a frozen use, exposure, step IDs and actual evidence");
      }

      const current = await data();
      if (!current.ok) return current;

      if (callSignal?.aborted) return workflowFailure("cancelled", "The feedback was cancelled during its read");

      if (!isOpen()) return workflowFailure("workflow_runtime_closed", "The run closed before its feedback could be accepted");

      const use = current.value.view.uses.find(item => item.use.useId === raw.useId && item.sessionId === options.sessionId);
      const artifact = current.value.view.versions.find(item => item.versionId === use?.use.versionId);
      if (use === undefined || artifact === undefined) return workflowFailure("workflow_use_unavailable", "Only this session's persisted frozen use accepts feedback");

      if (current.value.view.feedback.some(item => item.useId === use.use.useId && item.userAssessment === undefined)) return workflowFailure("workflow_feedback_already_recorded", "A use has one immutable final model feedback; obtain a new use for later work");

      const receipts = current.value.observed.receipts.filter(item => item.sequence > use.afterSequence);
      let autoExecution: string | undefined;

      if (raw.evidenceRefs === undefined) {
        const executions = [...new Set((current.value.observed.pendingHooks ?? []).filter(item => item.toolCallId === callId
          && item.operation === "feedback" && item.useId === use.use.useId).map(item => item.executionId))];
        if (executions.length !== 1) return workflowFailure("workflow_feedback_issuance_unavailable", "Automatic receipt binding requires this feedback call's unique durable workflow issuance");
        autoExecution = executions[0]!;
      }

      const refs = raw.evidenceRefs === undefined ? [...new Set(receipts.filter(item => item.executionId === autoExecution
        && item.tool !== "workflow_learning").map(item => item.ref))] : raw.evidenceRefs as string[];
      if (raw.evidenceRefs === undefined && raw.exposure === "reported_used" && refs.length === 0) {
        return workflowFailure("workflow_feedback_receipts_unavailable", "No post-adoption business receipt belongs to this actual feedback execution");
      }

      const followed = raw.followedStepIds as string[];
      if (refs.some(ref => !receipts.some(item => item.ref === ref)) || followed.some(id => !artifact.artifact.proposal.procedure.steps.some(step => step.id === id))) {
        return workflowFailure("workflow_feedback_unbound", "Feedback references must bind actual post-adoption receipts and frozen step IDs");
      }

      const executionIds = [...new Set(receipts.filter(item => refs.includes(item.ref)).map(item => item.executionId))];
      if (executionIds.length > 1) return workflowFailure("workflow_feedback_execution_mismatch", "One attributed feedback must concern one real execution");

      let quality: WorkflowImprovementFeedback["quality"] = "unknown", comparison: WorkflowImprovementFeedback["comparison"];
      let processEvidence: NonNullable<WorkflowImprovementFeedback["processEvidence"]> = { kind: "unverified" };

      if (raw.exposure === "reported_used" && refs.length > 0 && options.assessQuality !== undefined) {
        const assessed = await options.assessQuality({ use: use.use, artifact: artifact.artifact, receipts, evidenceRefs: refs });
        if (!assessed.ok) return assessed;
        quality = assessed.value.quality;
        comparison = assessed.value.comparison;
        processEvidence = assessed.value.processEvidence ?? { kind: "unverified" };
      }

      const executionId = autoExecution ?? executionIds[0] ?? current.value.observed.executionId;
      const parsed = parseWorkflowImprovementFeedback({ feedbackId: `workflow-feedback:${contentHashOf([options.sessionId,
        executionId, use.use.useId, callId])}`, ...use.use, executionId,
        exposure: raw.exposure, quality, processEvidence, evidenceRefs: refs, followedStepIds: followed, explanation: raw.explanation,
        ...(comparison === undefined ? {} : { comparison }) });
      if (!parsed.ok) return parsed;

      const bound = bindWorkflowProcessEvidence(parsed.value, artifact.artifact, receipts);
      if (!bound.ok) return bound;

      if (!options.publicData(parsed.value)) return workflowFailure("workflow_private_report", "Checker metadata must cross the same public-data boundary");

      const saved = await options.store.save({ type: "workflow_improvement_feedback", schemaVersion: 1, feedback: parsed.value }, at(), signal);

      if (callSignal?.aborted) return workflowFailure("cancelled", "The feedback was cancelled; inspect any already committed report");

      return saved.ok ? { ok: true, value: { status: "recorded", feedback: {
        feedbackId: parsed.value.feedbackId, useId: parsed.value.useId, versionId: parsed.value.versionId,
        executionId: parsed.value.executionId, exposure: parsed.value.exposure, quality: parsed.value.quality,
        processEvidence: { kind: parsed.value.processEvidence?.kind ?? "unverified" },
        evidenceBinding: raw.evidenceRefs === undefined ? "host_execution_window" : "explicit_refs",
        evidenceCount: parsed.value.evidenceRefs.length, selfReportedStepCount: parsed.value.followedStepIds.length },
        reputation: workflowImprovementReputation(artifact.artifact, [...current.value.view.feedback, parsed.value], artifact.versionId, use.use.task) } } : saved;
    },
    /** Explicit host handoff/testing may wait; the ordinary business path never calls this. */
    async settlePending() {
      await Promise.all([...workers.values()].map(worker => worker.done));
    },
    async close() {
      if (state === "closed") return;

      state = "closed";
      lifetime.abort();
      const pending = [...workers.values()];

      for (const worker of pending) worker.abort.abort();

      const grace = Math.max(0, Math.min(options.closeGraceMs ?? 1000, 1000));
      if (await workflowSettlementWithin(Promise.all(pending.map(worker => worker.done)), grace) && unsettled.size === 0) return { kind: "settled" as const };

      const fundings = [...new Map([...pending.map(worker => [worker.funded.jobId, worker.funded] as const), ...unsettled.entries()]).values()];
      const stopped = Promise.all(fundings.map(async funded => {
        const result = await stopFunded(funded);
        if (!result.ok) options.warn(result.code);
        return result.ok;
      }));
      const completed = await workflowSettlementWithin(stopped, grace);
      const durable = completed && (await stopped).every(Boolean);

      options.warn(durable ? "workflow_close_cancelled" : "workflow_close_unsettled_reservations_held");

      return { kind: durable ? "cancelled" as const : "usage_reserved" as const,
        jobIds: fundings.map(funded => funded.jobId) };
    },
  };
}

export type WorkflowImprovementRuntime = ReturnType<typeof createWorkflowImprovementRuntime>;
