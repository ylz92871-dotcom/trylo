import type { CliContext } from "./context.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { workflowSessionEvidence } from "./workflow-session-evidence.js";
import { parseWorkflowOperatorArgs, splitWorkflowProviderArgs, workflowIntegerOption } from "./workflow-learning-args.js";
import { parseWorkflowProviderFlags, standaloneWorkflowContext, withWorkflowLearningSignal } from "./workflow-learning-provider.js";
import { classifyAutomaticWorkflow, learnAutomaticWorkflow } from "../../integration/workflow-learning/automatic-runtime.js";
import { listWorkflowVersions } from "../../integration/workflow-learning/archive.js";
import { familiesFromVersions } from "../../integration/workflow-learning/known-families.js";
import { readLearnedWorkflowJobForTurn } from "../../integration/workflow-learning/automatic-jobs.js";
import { workflowVersionForObservation } from "../../integration/workflow-learning/observed-version.js";
import { persistWorkflowInstanceFeedback, resolveLatestWorkflowInstance } from "../../integration/workflow-learning/run-adoption.js";
import { recommendAutomaticWorkflow } from "../../integration/workflow-learning/recommendation.js";
import type { WorkflowLearningResult } from "../../learning/domains/workflow/trace-contracts.js";
import { workflowFailure } from "../../learning/domains/workflow/trace-parse.js";

/** Learn an existing committed turn through the same automatic subsystem.
 * This composes no task executor, tool catalog, session writer or permission.
 */
export async function handleWorkflowSessionLearning(ctx: CliContext, argv: readonly string[]): Promise<WorkflowLearningResult<unknown>> {
  const split = splitWorkflowProviderArgs(argv.slice(1)), parsed = parseWorkflowOperatorArgs(split.head, ["budget"]);
  if (!parsed.ok) return parsed;

  if (parsed.value.positional.length !== 1) return workflowFailure("workflow_usage", "learn-session needs one existing session id");

  const sessionId = parsed.value.positional[0]!;
  const budget = workflowIntegerOption(parsed.value.values.get("budget"), 16000);
  if (!budget.ok) return budget;

  const run = parseWorkflowProviderFlags(split.provider);
  if (!run.ok) return run;

  const evidence = await workflowSessionEvidence(ctx, sessionId);
  if (!evidence.ok) return evidence;

  const boardRoot = workflowBoardRoot(ctx), versions = await listWorkflowVersions(boardRoot);
  if (!versions.ok) return versions;

  const latest = await resolveLatestWorkflowInstance(boardRoot, evidence.value.records);
  if (!latest.ok) return latest;

  const instance = latest.value?.instance;
  const adopted = instance !== undefined && instance.startSequence < evidence.value.turnStartSequence
    && (instance.completion === undefined || instance.completion.atSequence >= evidence.value.turnStartSequence);
  let requiredTraceId: string | undefined;

  if (adopted && latest.value !== undefined) {
    const feedback = await persistWorkflowInstanceFeedback(boardRoot, latest.value, new Date(ctx.now()).toISOString());
    if (!feedback.ok) return feedback;
    requiredTraceId = feedback.value.trace.traceId;
  }

  const cached = await readLearnedWorkflowJobForTurn({ boardRoot, scope: evidence.value.scope, sessionId,
    turnId: evidence.value.observed.turnId, observed: evidence.value.observed });
  if (!cached.ok) return cached;

  const reused = cached.value?.latestOutcome?.kind === "learned" ? cached.value.latestOutcome.versionId
    : workflowVersionForObservation(versions.value, evidence.value.scope, evidence.value.observed);
  if (reused !== undefined) {
    if (requiredTraceId !== undefined && !versions.value.find(version => version.versionId === reused)?.artifact.traces.some(trace => trace.traceId === requiredTraceId)) {
      return workflowFailure("workflow_feedback_not_learned", `the cached result omitted committed adopted feedback; explicitly retry ${cached.value?.job.jobId ?? "the original learning job"} with a fresh grant`);
    }
    return { ok: true, value: { outcome: { kind: "learned", versionId: reused }, reused: true, modelCalls: 0 } };
  }

  const context = standaloneWorkflowContext(ctx, run.value, budget.value);
  if (!context.ok) return context;

  return withWorkflowLearningSignal(ctx, async signal => {
    let task = adopted ? instance!.adoption.task : undefined, spent = 0;
    if (task === undefined) {
      const classified = await classifyAutomaticWorkflow(context.value, { text: evidence.value.text, scope: evidence.value.scope,
        families: familiesFromVersions(versions.value, evidence.value.scope), sessionId, watermark: evidence.value.watermark,
        observed: evidence.value.observed }, signal);
      if (!classified.ok) return classified;
      if (classified.value.kind !== "classified") return { ok: true, value: classified.value };
      task = classified.value.task;
      spent = classified.value.spent;
    }

    const parent = adopted ? instance!.adoption.versionId : recommendAutomaticWorkflow(versions.value, task).learningParent?.versionId;

    return learnAutomaticWorkflow(context.value, { task, observed: evidence.value.observed, adopted,
      remaining: signal.aborted ? 0 : Math.max(0, budget.value - spent), ...(parent === undefined ? {} : { parentVersionId: parent }) }, signal);
  });
}
