import path from "node:path";
import { createHash } from "node:crypto";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import type { RunCommandOptions } from "./args-primitives.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { fail, type RunFailure } from "./run-failure.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { readWorkflowVersion } from "../../integration/workflow-learning/archive.js";
import { createWorkflowExecution } from "../../integration/workflow-learning/execution.js";
import { commitWorkflowAdoption, commitWorkflowBudgetGrant, commitWorkflowCheckpointInvalidation, completeWorkflowAdoption, persistWorkflowInstanceFeedback, resolveLatestWorkflowInstance, workflowBudgetTrace, type WorkflowCheckpointInvalidation, type WorkflowBudgetGrant, type WorkflowRunAdoption, type WorkflowRunNomination } from "../../integration/workflow-learning/run-adoption.js";
import { compileWorkflow, selectWorkflowPath } from "../../learning/domains/workflow/trace-learn.js";
import { parseWorkflowTask } from "../../learning/domains/workflow/trace-parse.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { WorkflowTrace } from "../../learning/domains/workflow/trace-contracts.js";
import { resolveInsideWorkspace } from "../../adapters/tools/shared/workspace.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

function refusal(message: string): RunFailure { return fail(EXIT_CODES.CONFIG, message, "resume the frozen workflow context, or start a new session for a different workflow or allowance"); }

/** Restore the original workflow adoption before considering a new nomination or allowance. */
export async function openWorkflowRun(ctx: CliContext, options: RunCommandOptions, scaffold: RunScaffold, automatic?: WorkflowRunNomination,
  onSnapshot?: (trace: WorkflowTrace) => void) {
  const boardRoot = workflowBoardRoot(ctx);
  const restored = await resolveLatestWorkflowInstance(boardRoot, scaffold.resumeRecords ?? []);
  if (!restored.ok) return refusal(`${restored.code}: ${restored.message}`);

  let nominated = automatic;

  if (options.workflowVersion !== undefined || options.workflowTask !== undefined) {
    if (options.workflowVersion === undefined || options.workflowTask === undefined) return refusal("workflow version and task context are required together");

    const raw = ctx.readFile(path.resolve(ctx.cwd, options.workflowTask));
    if (raw === undefined) return refusal("workflow task context is unreadable");

    let value: unknown;

    try { value = JSON.parse(raw); } catch { return refusal("invalid_task_json: workflow task context must be valid JSON"); }

    const task = parseWorkflowTask(value);
    if (!task.ok) return refusal(`${task.code}: ${task.message}`);

    nominated = { versionId: options.workflowVersion, task: task.value };
  }

  const latest = restored.value;
  const previous = latest === undefined || latest.completed ? undefined : latest.instance.adoption;
  if (previous === undefined && options.workflowRefillTokens !== undefined) return refusal("workflow_refill_requires_active_instance: completed or absent instances receive a new initial allowance");

  if (previous === undefined && nominated === undefined) return undefined;

  if (previous !== undefined && nominated !== undefined && (previous.versionId !== nominated.versionId
    || contentHashOf(previous.task) !== contentHashOf(nominated.task))) return refusal("workflow_adoption_conflict: version or task premises changed on resume");

  const nomination = previous ?? nominated!;

  if (scaffold.session === undefined) return refusal("workflow execution requires the existing durable session journal");

  const loaded = await readWorkflowVersion(boardRoot, nomination.versionId);
  if (!loaded.ok) return refusal(`${loaded.code}: ${loaded.message}`);

  const selected = selectWorkflowPath(loaded.value, nomination.task);
  if (!selected.ok) return refusal(`${selected.code}: ${selected.message}`);

  const artifactHash = contentHashOf(loaded.value);
  if (previous !== undefined && (previous.artifactHash !== artifactHash || previous.adoptedBranchId !== selected.value.adoptedBranchId)) return refusal("workflow_adoption_conflict: frozen workflow content or selected branch changed");

  const adoption: WorkflowRunAdoption = previous ?? { ...nomination, instanceId: ctx.newId("workflow-run"), artifactHash,
    ...(selected.value.adoptedBranchId === undefined ? {} : { adoptedBranchId: selected.value.adoptedBranchId }),
    budget: { ...(scaffold.maxTokens === undefined ? {} : { maxOutputTokens: scaffold.maxTokens }),
      ...(scaffold.maxIterations === undefined ? {} : { maxIterations: scaffold.maxIterations }),
      ...(scaffold.maxBudgetUsd === undefined ? {} : { maxCostUsd: scaffold.maxBudgetUsd }),
      ...(scaffold.inputPricePerMTok === undefined ? {} : { inputPricePerMTok: scaffold.inputPricePerMTok }),
      ...(scaffold.outputPricePerMTok === undefined ? {} : { outputPricePerMTok: scaffold.outputPricePerMTok }) } };
  if (previous !== undefined && ((options.maxTokens !== undefined && options.maxTokens !== adoption.budget.maxOutputTokens)
    || (options.maxIterations !== undefined && options.maxIterations !== adoption.budget.maxIterations)
    || (options.maxBudgetUsd !== undefined && options.maxBudgetUsd !== adoption.budget.maxCostUsd))) return refusal("workflow_allowance_conflict: a resumed run retains its original allowance");

  if (previous === undefined) {
    if (latest?.completed && latest.instance.completion === undefined && latest.terminalTurnId !== undefined) {
      const sealed = await completeWorkflowAdoption(scaffold.session, scaffold.sessionId, latest.instance.adoption,
        latest.trace, latest.terminalTurnId, new Date(ctx.now()).toISOString());
      if (!sealed.ok) return refusal(`workflow_completion_persistence_failed:${sealed.code}`);
    }

    const saved = await commitWorkflowAdoption(scaffold.session, scaffold.sessionId, adoption, new Date(ctx.now()).toISOString());
    if (!saved.ok) return refusal(`workflow_adoption_persistence_failed:${saved.code}`);
  }

  // Output reuse depends on the current workspace bytes, not only saved trace claims.
  const outputDigest = (reference: string): string | undefined => {
    const target = resolveInsideWorkspace(scaffold.workspaceRoot, reference);
    if (!target.ok) return undefined;
    const value = ctx.readFile(target.absolutePath);
    return value === undefined ? undefined : createHash("sha256").update(value).digest("hex");
  };
  const projectionInput: Parameters<typeof createWorkflowExecution>[0] = { artifact: selected.value.artifact, versionId: adoption.versionId,
    traceId: ctx.newId("workflow-trace"), executionId: adoption.instanceId, sessionId: scaffold.sessionId,
    ...(previous === undefined || scaffold.resumeRecords === undefined ? {} : { resumeRecords: scaffold.resumeRecords.filter(record => record.sequence > latest!.instance.startSequence) }),
    ...(adoption.adoptedBranchId === undefined ? {} : { adoptedBranchId: adoption.adoptedBranchId }), outputDigest,
    ...(adoption.task.conditions === undefined ? {} : { conditions: adoption.task.conditions,
      conditionEvidenceRefs: adoption.conditionEvidenceRefs ?? [`session:${scaffold.sessionId}/extension:workflow/${adoption.instanceId}`] }) };
  const execution = createWorkflowExecution(projectionInput);
  const committed = createWorkflowExecution(projectionInput);

  if (execution.restoredInvalidation !== undefined) {
    const saved = await commitWorkflowCheckpointInvalidation(scaffold.session, scaffold.sessionId, adoption, execution.restoredInvalidation, new Date(ctx.now()).toISOString());
    if (!saved.ok) return refusal(`workflow_invalidation_persistence_failed:${saved.code}`);
  }

  const invalidations: WorkflowCheckpointInvalidation[] = [];

  function revalidateArtifacts() {
    execution.revalidateOutputs();
    const invalidation = committed.revalidateOutputs();
    if (invalidation !== undefined) invalidations.push(invalidation);
  }

  const used = execution.accounting();
  const budget = adoption.budget;
  let grants = previous === undefined ? [] : [...latest!.instance.grants];

  if (options.workflowRefillTokens !== undefined || options.workflowBudgetGrant !== undefined) {
    if (options.workflowRefillTokens === undefined || options.workflowBudgetGrant === undefined || budget.maxOutputTokens === undefined
      || !Number.isSafeInteger(options.workflowRefillTokens) || options.workflowRefillTokens <= 0) return refusal("invalid_workflow_refill: a token-capped active instance, positive tokens and host grant id are required");

    const prior = grants.find(grant => grant.grantId === options.workflowBudgetGrant);
    if (prior !== undefined && prior.tokens !== options.workflowRefillTokens) return refusal("workflow_budget_grant_conflict: the same grant id cannot change allowance");

    if (prior === undefined) {
      if (!Number.isSafeInteger(budget.maxOutputTokens + grants.reduce((sum, grant) => sum + grant.tokens, 0) + options.workflowRefillTokens)) {
        return refusal("workflow_budget_overflow: a grant cannot exceed safe accounting range");
      }

      const covered = new Set(grants.flatMap(grant => grant.unknownRequests));
      const unknownRequests = used.unknownRequestIds.filter(id => !covered.has(id));
      const available = budget.maxOutputTokens + grants.reduce((sum, grant) => sum + grant.tokens - grant.unknownReservation, 0) - used.outputTokens;
      const grant: WorkflowBudgetGrant = { grantId: options.workflowBudgetGrant, tokens: options.workflowRefillTokens,
        unknownReservation: unknownRequests.length === 0 ? 0 : Math.max(0, available), unknownRequests };
      const saved = await commitWorkflowBudgetGrant(scaffold.session, scaffold.sessionId, adoption, grant, new Date(ctx.now()).toISOString());
      if (!saved.ok) return refusal(`workflow_budget_grant_persistence_failed:${saved.code}`);

      grants = [...grants, grant];
    }
  }

  const grantedTokens = grants.reduce((sum, grant) => sum + grant.tokens, 0);
  const reservedUnknownTokens = grants.reduce((sum, grant) => sum + grant.unknownReservation, 0);
  const snapshotTrace = (): WorkflowTrace => workflowBudgetTrace(committed.trace(), budget, grants, committed.accounting());

  onSnapshot?.(snapshotTrace());
  const coveredUnknowns = new Set(grants.flatMap(grant => grant.unknownRequests));
  if (used.usageUncertain && (budget.maxCostUsd !== undefined || (budget.maxOutputTokens !== undefined && used.unknownRequestIds.some(id => !coveredUnknowns.has(id))))) {
    return refusal("workflow_usage_reconciliation_required: provider usage is unknown; reconcile it or explicitly grant new tokens with conservative reservation of the old remainder");
  }

  const remainingTokens = budget.maxOutputTokens === undefined ? undefined : budget.maxOutputTokens + grantedTokens - reservedUnknownTokens - used.outputTokens;
  if (remainingTokens !== undefined && !Number.isSafeInteger(remainingTokens)) return refusal("workflow_budget_overflow: total token grants exceed safe accounting range");

  const remainingIterations = budget.maxIterations === undefined ? undefined : budget.maxIterations - used.iterations;
  const remainingCost = budget.maxCostUsd === undefined ? undefined : budget.maxCostUsd
    - ((used.inputTokens * (budget.inputPricePerMTok ?? 0) + used.outputTokens * (budget.outputPricePerMTok ?? 0)) / 1000000);
  if ((remainingTokens !== undefined && remainingTokens <= 0) || (remainingIterations !== undefined && remainingIterations <= 0)
    || (remainingCost !== undefined && remainingCost <= 0)) return refusal("workflow_budget_exhausted: the frozen run allowance was consumed; no provider or tool was restarted");

  const compiled = compileWorkflow(loaded.value, adoption.task, 8192);
  if (!compiled.ok) return refusal(`${compiled.code}: ${compiled.message}`);

  const prepared: RunScaffold = { ...scaffold,

    onCommittedEnvelope(event) {
      committed.observeCommitted(event);
      scaffold.onCommittedEnvelope?.(event);
      if (event.kind === "terminal") {
        revalidateArtifacts();
        onSnapshot?.(snapshotTrace());
      }
    },

    onCommittedEffect(key, outcome) {
      scaffold.onCommittedEffect?.(key, outcome);
      onSnapshot?.(snapshotTrace());
    },

    ...(remainingTokens === undefined ? {} : { maxTokens: remainingTokens }),
    ...(remainingIterations === undefined ? {} : { maxIterations: remainingIterations }),
    ...(remainingCost === undefined ? {} : { maxBudgetUsd: remainingCost }),
    ...(budget.inputPricePerMTok === undefined ? {} : { inputPricePerMTok: budget.inputPricePerMTok }),
    ...(budget.outputPricePerMTok === undefined ? {} : { outputPricePerMTok: budget.outputPricePerMTok }),
    systemPromptAppend: [scaffold.systemPromptAppend, `Frozen workflow version ${adoption.versionId}. ${compiled.value}`,
      `Durable workflow progress: ${JSON.stringify(execution.progress())}. Consume actual inputBindings from workflow_progress, not historical example filenames. After a check, call workflow_record_step immediately.`,
    ].filter(value => value !== undefined).join("\n") };

  return { scaffold: prepared, tools: execution.tools, observe(event: import("../../protocol/envelope.js").Envelope) {
    execution.observe(event);
  }, execution,

    codeFor: (code: ExitCode): ExitCode => {
      revalidateArtifacts();
      return code === EXIT_CODES.OK && committed.trace().outcome !== "success" ? EXIT_CODES.EXECUTION_FAILURE : code;
    },

    async finish() {
      revalidateArtifacts();

      for (const invalidation of invalidations) {
        const stored = await commitWorkflowCheckpointInvalidation(scaffold.session!, scaffold.sessionId, adoption, invalidation, new Date(ctx.now()).toISOString());
        if (!stored.ok) throw new Error(`workflow_invalidation_persistence_failed:${stored.code}`);
      }

      const facts = await scaffold.session!.readRecords();
      if (!facts.ok) throw new Error(`workflow_completion_read_failed:${facts.code}`);

      const resolved = await resolveLatestWorkflowInstance(boardRoot, facts.view.records);
      if (!resolved.ok || resolved.value === undefined || resolved.value.instance.adoption.instanceId !== adoption.instanceId) throw new Error("workflow_feedback_history_invalid");

      const trace = resolved.value.trace;
      if (trace.outcome !== snapshotTrace().outcome || contentHashOf(trace.steps) !== contentHashOf(snapshotTrace().steps)) throw new Error("workflow_feedback_projection_conflict");

      const saved = options.workflowCollection === "disabled" ? undefined : await persistWorkflowInstanceFeedback(boardRoot, resolved.value, new Date(ctx.now()).toISOString());
      if (saved !== undefined && !saved.ok) throw new Error(`workflow_feedback_persistence_failed:${saved.code}:${saved.message}`);

      try {
        if (trace.outcome === "success") {
          const terminalTurnId = resolved.value.terminalTurnId;
          if (terminalTurnId === undefined) throw new Error("workflow_completion_terminal_missing");
          const sealed = await completeWorkflowAdoption(scaffold.session!, scaffold.sessionId, adoption, trace, terminalTurnId, new Date(ctx.now()).toISOString());
          if (!sealed.ok) throw new Error(`workflow_completion_persistence_failed:${sealed.code}`);
        }

        onSnapshot?.(trace);
        ctx.stderr(`workflow_feedback ${JSON.stringify({ workflowVersionId: adoption.versionId, sessionId: scaffold.sessionId,
          traceId: trace.traceId, collected: saved !== undefined, ...(saved === undefined ? {} : { feedbackVersionId: saved.value.versionId }),
          outcome: trace.outcome, runState: trace.runState, checkpoints: trace.steps.length })}\n`);
      } finally {
        if (saved?.ok) await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: scaffold.workspaceRoot,
          reason: "workflow_instance_feedback_committed", sourceRefs: [trace.traceId, saved.value.versionId] });
      }
    } };
}
