import path from "node:path";
import type { CliContext } from "./context.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { parseWorkflowOperatorArgs, splitWorkflowProviderArgs, workflowIntegerOption } from "./workflow-learning-args.js";
import { parseWorkflowProviderFlags, standaloneWorkflowContext, withWorkflowLearningSignal } from "./workflow-learning-provider.js";
import { workflowSessionEvidence } from "./workflow-session-evidence.js";
import {
  enqueueWorkflowLearningJob, readPendingWorkflowLearningJobs, readWorkflowLearningJob, recoverWorkflowLearningJob, retryWorkflowLearningJob,
  type WorkflowLearningJobView,
} from "../../integration/workflow-learning/automatic-jobs.js";
import { processAutomaticWorkflowInput } from "../../integration/workflow-learning/automatic-runtime.js";
import { knownAutomaticWorkflowFamilies } from "../../integration/workflow-learning/known-families.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { WorkflowLearningResult } from "../../learning/domains/workflow/trace-contracts.js";
import { workflowFailure } from "../../learning/domains/workflow/trace-parse.js";

export async function handleWorkflowJobCommand(ctx: CliContext, argv: readonly string[]): Promise<WorkflowLearningResult<unknown>> {
  const [verb, ...rest] = argv, split = splitWorkflowProviderArgs(rest);
  const allowed = verb === "jobs" ? ["scope", "limit"] : verb === "recover" ? ["attempt"]
    : verb === "retry" ? ["grant", "tokens", "calls"] : verb === "work" ? ["prompt-file"] : [];
  const parsed = parseWorkflowOperatorArgs(split.head, allowed);
  if (!parsed.ok) return parsed;

  const { positional, values } = parsed.value;

  if (positional.length !== (verb === "jobs" ? 0 : 1) || (verb !== "work" && split.provider.length !== 0)) return workflowFailure("workflow_usage", "invalid workflow job arguments");

  const boardRoot = workflowBoardRoot(ctx), jobId = positional[0] ?? "", issuedAt = new Date(ctx.now()).toISOString();

  if (verb === "jobs") {
    const limit = workflowIntegerOption(values.get("limit"), 50, 128);
    if (!limit.ok) return limit;
    return readPendingWorkflowLearningJobs({ boardRoot, scope: values.get("scope") ?? workspaceIdentity(ctx.cwd), limit: limit.value });
  }

  if (verb === "job") return readWorkflowLearningJob({ boardRoot, jobId });

  if (verb === "recover") {
    const attempt = workflowIntegerOption(values.get("attempt"), undefined, 8);
    if (!attempt.ok) return attempt;
    return recoverWorkflowLearningJob({ boardRoot, jobId, expectedAttempt: attempt.value, issuedAt });
  }

  if (verb === "retry") {
    const tokens = workflowIntegerOption(values.get("tokens")), calls = workflowIntegerOption(values.get("calls"), 1, 16);
    if (!tokens.ok) return tokens;
    if (!calls.ok) return calls;
    if (values.get("grant") === undefined) return workflowFailure("workflow_usage", "retry requires an explicit new --grant identity");
    return retryWorkflowLearningJob({ boardRoot, jobId, allowance: { grantId: values.get("grant")!, maxCalls: calls.value, maxTokens: tokens.value }, issuedAt });
  }

  if (verb !== "work") return workflowFailure("workflow_usage", "unknown workflow job command");

  return workWorkflowJob(ctx, jobId, values, split.provider);
}

async function workWorkflowJob(ctx: CliContext, jobId: string, values: ReadonlyMap<string, string>, providerFlags: readonly string[]): Promise<WorkflowLearningResult<unknown>> {
  const boardRoot = workflowBoardRoot(ctx), run = parseWorkflowProviderFlags(providerFlags);
  if (!run.ok) return run;

  const current = await readWorkflowLearningJob({ boardRoot, jobId });
  if (!current.ok) return current;

  const input = current.value.input;
  let originalText: string | undefined;

  if (input.purpose === "classify") {
    const file = values.get("prompt-file");
    originalText = file === undefined ? undefined : ctx.readFile(path.resolve(ctx.cwd, file));
    if (originalText === undefined || originalText.length > 12000 || contentHashOf(originalText) !== input.promptHash) return workflowFailure("classification_input_mismatch", "work requires --prompt-file containing the exact bounded original classification prompt");
  } else if (values.has("prompt-file")) return workflowFailure("workflow_usage", "segmentation/revision already has immutable execution input; no prompt file is accepted");

  if (current.value.job.state !== "queued") return cachedSettlement(current.value);

  if (input.allowance.maxCalls === 0) {
    const staged = await enqueueWorkflowLearningJob({ boardRoot, input, issuedAt: new Date(ctx.now()).toISOString() });
    if (!staged.ok) return staged;
    const deferred = await readWorkflowLearningJob({ boardRoot, jobId });
    return deferred.ok ? cachedSettlement(deferred.value) : deferred;
  }

  let classification: Parameters<typeof processAutomaticWorkflowInput>[3];

  if (input.purpose === "classify") {
    const families = await knownAutomaticWorkflowFamilies(boardRoot, input.scope);
    if (!families.ok) return families;
    const evidence = input.sourceTurnId === undefined ? undefined : await workflowSessionEvidence(ctx, input.sessionId,
      { promptHash: input.promptHash, turnId: input.sourceTurnId, ...(input.journalWatermark === undefined ? {} : { journalWatermark: input.journalWatermark }) });
    if (evidence !== undefined && !evidence.ok) return evidence;
    if (evidence?.ok && evidence.value.scope !== input.scope) return workflowFailure("job_payload_conflict", "session workspace differs from the job scope");
    classification = { text: originalText!, families: families.value, ...(evidence?.ok ? { observed: evidence.value.observed } : {}) };
  }

  const context = standaloneWorkflowContext(ctx, run.value, input.allowance.maxTokens);
  if (!context.ok) return context;

  return withWorkflowLearningSignal(ctx, signal => processAutomaticWorkflowInput(context.value, input, signal, classification));
}

function cachedSettlement(view: WorkflowLearningJobView): WorkflowLearningResult<unknown> {
  const result = view.latestOutcome, usage = view.usage;
  return result !== undefined && result.kind !== "unknown"
    ? { ok: true, value: { outcome: result, tokens: usage !== undefined && "tokens" in usage ? usage.tokens : 0 } }
    : workflowFailure("job_not_queued", "inspect/recover this job and explicitly grant a retry; the old allowance was not reissued");
}
