import { contentHashOf } from "../../../../control/hash.js";
import type { WorkflowLearningResult, WorkflowTask } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowModelPort, WorkflowObservedTurn, WorkflowTraceProposal } from "./model-port.js";
import { enqueueWorkflowLearningJob, readWorkflowLearningJob, claimWorkflowLearningJob, finishWorkflowLearningJob } from "./automatic-jobs.js";
import type { WorkflowAutomaticInput, WorkflowJobOutcome, WorkflowJobClaim } from "./automatic-job-contracts.js";
import { bindWorkflowProposal } from "./raw-facts.js";
import { runWorkflowLearning } from "./runtime.js";
import { readSuccessfulWorkflowClassificationRetry } from "./automatic-classification-retries.js";

export type AutomaticWorkflowContext = { readonly boardRoot: string; readonly now: () => string; readonly model: WorkflowModelPort; readonly allowance: number };

export type AutomaticLearningSettlement = { readonly outcome: WorkflowJobOutcome; readonly tokens: number };

export type AutomaticClassification = { readonly kind: "classified"; readonly task: WorkflowTask; readonly spent: number }
  | { readonly kind: "not_classified"; readonly code: string; readonly spent: number };

/** One claim per model grant. A known committed result is reused after restart. */
async function perform(context: AutomaticWorkflowContext, input: WorkflowAutomaticInput, signal: AbortSignal,
  work: (claim: WorkflowJobClaim) => Promise<WorkflowJobOutcome>): Promise<WorkflowLearningResult<AutomaticLearningSettlement>> {
  let current = await readWorkflowLearningJob({ boardRoot: context.boardRoot, jobId: input.jobId });
  if (!current.ok && current.code === "job_not_found") {
    const enqueued = await enqueueWorkflowLearningJob({ boardRoot: context.boardRoot, input, issuedAt: context.now() });
    if (!enqueued.ok) return enqueued;
    current = await readWorkflowLearningJob({ boardRoot: context.boardRoot, jobId: input.jobId });
  }

  if (!current.ok) return current;

  if (contentHashOf(current.value.input) !== contentHashOf(input)) return workflowFailure("job_payload_conflict", "work must use the exact current immutable input and grant");

  const result = current.value.latestOutcome;
  if (current.value.job.state !== "queued" && result !== undefined && result.kind !== "unknown") {
    const usage = current.value.usage;
    return { ok: true, value: { outcome: result, tokens: usage !== undefined && "tokens" in usage ? usage.tokens : input.allowance.maxTokens } };
  }

  if (signal.aborted) return workflowFailure("cancelled", "workflow nomination was cancelled before claiming its grant");

  const claim = await claimWorkflowLearningJob({ boardRoot: context.boardRoot, jobId: input.jobId, issuedAt: context.now() });
  if (!claim.ok) return claim;

  const before = context.model.usage();
  let outcome: WorkflowJobOutcome;

  try { outcome = await work(claim.value); }
  catch { outcome = { kind: signal.aborted ? "cancelled" : "failed", code: "workflow_worker_unavailable" }; }

  const after = context.model.usage(), usage = { calls: Math.max(0, after.calls - before.calls), tokens: Math.max(0, after.tokens - before.tokens),
    observedTokens: Math.max(0, (after.observedTokens ?? after.tokens) - (before.observedTokens ?? before.tokens)),
    uncertain: after.uncertain === true || after.tokens - before.tokens > (after.observedTokens ?? after.tokens) - (before.observedTokens ?? before.tokens) };
  if (usage.calls > claim.value.input.allowance.maxCalls || usage.tokens > claim.value.input.allowance.maxTokens) outcome = { kind: "budget_exhausted", code: "model_allowance_exceeded" };

  const finished = await finishWorkflowLearningJob({ boardRoot: context.boardRoot, claim: claim.value, outcome, usage, issuedAt: context.now() });

  return finished.ok ? { ok: true, value: { outcome, tokens: usage.tokens } } : finished;
}

export async function classifyAutomaticWorkflow(context: AutomaticWorkflowContext, input: {
  readonly sessionId: string; readonly watermark: number; readonly text: string; readonly scope: string; readonly families: readonly WorkflowTask[];
  readonly observed?: WorkflowObservedTurn;
}, signal: AbortSignal): Promise<WorkflowLearningResult<AutomaticClassification>> {
  const promptHash = contentHashOf(input.text), jobId = `workflow-classify:${contentHashOf([input.sessionId, input.watermark, promptHash]).slice(0, 32)}`;
  const nomination: WorkflowAutomaticInput & { readonly purpose: "classify" } = { jobId, purpose: "classify", scope: input.scope, sessionId: input.sessionId,
    turnId: `input:${promptHash}`, promptHash, journalWatermark: input.watermark,
    ...(input.observed === undefined ? {} : { sourceTurnId: input.observed.turnId }),
    allowance: { grantId: `${jobId}:initial`, maxCalls: 2, maxTokens: context.allowance } };
  const paid = await readSuccessfulWorkflowClassificationRetry({ boardRoot: context.boardRoot, input: nomination });
  if (!paid.ok) return paid;

  if (paid.value !== null) return { ok: true, value: { kind: "classified", task: paid.value.task, spent: paid.value.usage.tokens } };

  const result = await processAutomaticWorkflowInput(context, nomination, signal,
    { text: input.text, families: input.families, ...(input.observed === undefined ? {} : { observed: input.observed }) });
  if (!result.ok) return result;

  return result.value.outcome.kind === "classified" ? { ok: true, value: { kind: "classified", task: result.value.outcome.task, spent: result.value.tokens } }
    : { ok: true, value: { kind: "not_classified", code: result.value.outcome.kind === "learned" ? "invalid_classification_result" : result.value.outcome.code, spent: result.value.tokens } };
}

/** Trace ingestion, segmentation, pure learning and commit finish inside one bounded reservation. */
export async function learnAutomaticWorkflow(context: AutomaticWorkflowContext, input: {
  readonly task: WorkflowTask; readonly observed: WorkflowObservedTurn; readonly parentVersionId?: string;
  readonly adopted: boolean; readonly remaining: number;
}, signal: AbortSignal): Promise<WorkflowLearningResult<AutomaticLearningSettlement>> {
  const { observed } = input;
  const jobId = `workflow-ingest:${contentHashOf([observed.sessionId, observed.turnId, input.task, input.parentVersionId ?? null]).slice(0, 32)}`;
  return processAutomaticWorkflowInput(context, { jobId, purpose: input.adopted ? "revise" : "segment", scope: input.task.scope, task: input.task,
    sessionId: observed.sessionId, turnId: observed.turnId, observed,
    ...(input.parentVersionId === undefined ? {} : { parentVersionId: input.parentVersionId }),
    allowance: { grantId: `${jobId}:initial`, maxCalls: input.remaining > 0 ? input.adopted ? 1 : 2 : 0, maxTokens: input.remaining } }, signal);
}

/** Shared by ordinary after-turn learning and the independently callable work command. */
export async function processAutomaticWorkflowInput(context: AutomaticWorkflowContext, input: WorkflowAutomaticInput, signal: AbortSignal,
  classification?: { readonly text: string; readonly families: readonly WorkflowTask[]; readonly observed?: WorkflowObservedTurn }): Promise<WorkflowLearningResult<AutomaticLearningSettlement>> {
  return perform(context, input, signal, async claim => {
    const current = claim.input;
    const initialUsage = context.model.usage();
    const remaining = () => Math.max(0, current.allowance.maxTokens - (context.model.usage().tokens - initialUsage.tokens));
    const canCall = () => context.model.usage().calls - initialUsage.calls < current.allowance.maxCalls && remaining() > 0 && !signal.aborted;

    if (current.purpose === "classify") {
      if (classification === undefined || contentHashOf(classification.text) !== current.promptHash) return { kind: "failed", code: "classification_input_mismatch" };

      let validationError: string | undefined, lastCode: string | undefined;

      for (let attempt = 0; attempt < current.allowance.maxCalls && canCall(); attempt += 1) {
        const classified = await context.model.classify({ ...classification, scope: current.scope,
          ...(validationError === undefined ? {} : { validationError }) }, signal, remaining());
        if (classified.ok) return { kind: "classified", task: classified.value };

        if (!["invalid_task", "learning_invalid_json", "learning_conditions_missing"].includes(classified.code)) return {
          kind: signal.aborted ? "cancelled" : classified.code === "learning_abstained" ? "abstained"
            : classified.code === "learning_budget_exhausted" ? "budget_exhausted" : "failed", code: classified.code };

        lastCode = classified.code;
        validationError = `${classified.code}: ${classified.message}`;
      }

      return { kind: signal.aborted ? "cancelled" : validationError === undefined ? "budget_exhausted" : "abstained",
        code: validationError === undefined ? "learning_budget_exhausted" : `classification_repair_exhausted:${lastCode}` };
    }

    let traces: unknown[] = [];

    if (current.purpose === "segment") {
      if (current.observed === undefined) return { kind: "failed", code: "missing_execution_facts" };

      let validationError: string | undefined, lastCode: string | undefined, previousProposal: WorkflowTraceProposal | undefined;

      for (let attempt = 0; attempt < Math.max(1, current.allowance.maxCalls); attempt += 1) {
        if (current.observed.checks.length > 0 && !canCall()) return { kind: signal.aborted ? "cancelled" : "budget_exhausted", code: "learning_budget_exhausted" };

        const proposal = current.observed.checks.length === 0 ? { ok: true as const, value: { steps: [] } }
          : await context.model.segment({ task: current.task, observed: current.observed,
            ...(validationError === undefined ? {} : { validationError }), ...(previousProposal === undefined ? {} : { previousProposal }) }, signal, remaining());
        if (!proposal.ok) {
          if (!["invalid_trace_proposal", "learning_invalid_json"].includes(proposal.code)) return {
            kind: signal.aborted ? "cancelled" : proposal.code === "learning_budget_exhausted" ? "budget_exhausted" : "failed", code: proposal.code };
          lastCode = proposal.code;
          validationError = `${proposal.code}: ${proposal.message}`;
          continue;
        }

        const trace = bindWorkflowProposal(current.task, current.observed, proposal.value);
        if (trace.ok) {
          traces = [trace.value];
          break;
        }

        previousProposal = proposal.value;
        lastCode = trace.code;
        validationError = `${trace.code}: ${trace.message}`;
      }

      if (traces.length === 0) return { kind: "abstained", code: `segmentation_repair_exhausted:${lastCode}` };
    }

    const learned = await runWorkflowLearning({ boardRoot: context.boardRoot, issuedAt: context.now(), signal,
      request: { ...current.task, requestId: current.jobId, subsystem: "workflow", collect: true,
        budget: { maxEpisodes: 32, maxSteps: 2048, maxTokens: 131072, maxRounds: 8 }, traces,
        ...(current.parentVersionId === undefined ? {} : { parentVersionId: current.parentVersionId }) } });

    return learned.ok ? { kind: "learned", versionId: learned.value.versionId } : { kind: signal.aborted ? "cancelled" : "failed", code: learned.code };
  });
}
