import path from "node:path";
import type { CliContext } from "./context.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { parseWorkflowOperatorArgs, splitWorkflowProviderArgs, workflowIntegerOption } from "./workflow-learning-args.js";
import { parseWorkflowProviderFlags, withWorkflowLearningSignal } from "./workflow-learning-provider.js";
import { standaloneWorkflowImprovementModel } from "./workflow-improvement-wiring.js";
import { workflowSessionEvidence } from "./workflow-session-evidence.js";
import { commitWorkflowImprovementRecord, readWorkflowImprovements } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { fileWorkflowImprovementPorts } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { workflowImprovementPublicData, projectWorkflowImprovementEvidence } from "../../learning/agent/subsystems/workflow/adapters/improvement-evidence.js";
import { workWorkflowImprovement } from "../../learning/agent/subsystems/workflow/runtime/improvement-worker.js";
import { parseWorkflowImprovementFeedback, workflowImprovementReputation } from "../../learning/agent/subsystems/workflow/improvement/index.js";
import { workflowFailure } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import type { WorkflowLearningResult } from "../../learning/agent/subsystems/workflow/domain/trace-contracts.js";
import type { SessionRecord } from "../../ports/session.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

/** Operator commands inspect existing data or explicitly fund a saved opportunity; no task tools are composed. */
export async function handleWorkflowImprovementCommand(ctx: CliContext, argv: readonly string[]): Promise<WorkflowLearningResult<unknown>> {
  const [verb, ...tail] = argv, split = splitWorkflowProviderArgs(tail);
  const parsed = parseWorkflowOperatorArgs(split.head, verb === "improve-work" ? ["grant", "tokens"] : verb === "improve-user-feedback" ? ["note-file"] : []);
  if (!parsed.ok) return parsed;

  const { positional, values } = parsed.value;

  if (positional.length !== (verb === "improvements" ? 0 : 1) || verb !== "improve-work" && split.provider.length > 0) {
    return workflowFailure("workflow_usage", "Invalid improvement command arguments");
  }

  const boardRoot = workflowBoardRoot(ctx), scope = workspaceIdentity(ctx.cwd), view = await readWorkflowImprovements(boardRoot, scope, ctx.cwd);
  if (!view.ok) return view;

  const target = positional[0] ?? "";

  if (verb === "improvements") return { ok: true, value: { opportunities: view.value.opportunities, uses: view.value.uses,
    feedback: view.value.feedback, recentIssues: view.value.recentIssues,
    versions: view.value.versions.map(item => ({ ...item, reputation: workflowImprovementReputation(item.artifact, view.value.feedback, item.versionId) })) } };

  if (verb === "improvement") {
    const version = view.value.versions.find(item => item.versionId === target);
    const opportunity = view.value.opportunities.find(item => item.versionId === target);
    return version !== undefined ? { ok: true, value: { ...version, feedback: view.value.feedback.filter(item => item.versionId === target),
      uses: view.value.uses.filter(item => item.use.versionId === target), reputation: workflowImprovementReputation(version.artifact, view.value.feedback, target) } }
      : opportunity !== undefined ? { ok: true, value: opportunity } : workflowFailure("workflow_improvement_not_found", "No improvement record exists in this workspace");
  }

  if (verb === "improve-user-feedback") return userFeedback(ctx, target, values.get("note-file"));

  if (verb !== "improve-work") return workflowFailure("workflow_usage", "Unknown improvement command");

  const grant = values.get("grant"), tokens = workflowIntegerOption(values.get("tokens"));
  if (grant === undefined || grant.length > 200) return workflowFailure("workflow_usage", "improve-work needs an explicit --grant identity and --tokens allowance");

  if (!tokens.ok) return tokens;

  const opportunity = view.value.opportunities.find(item => item.versionId === target);
  if (opportunity === undefined) return workflowFailure("workflow_improvement_not_found", "Select an immutable saved opportunity from improvements");

  const run = parseWorkflowProviderFlags(split.provider);
  if (!run.ok) return run;

  const model = standaloneWorkflowImprovementModel(ctx, run.value);
  if (!model.ok) return model;

  const budgetId = `workflow-operator:${grant}`, services = fileWorkflowImprovementPorts({ boardRoot, scope, centralScope: ctx.cwd, budgetId, allowance: tokens.value, now: ctx.now });
  const funding = services.funding;
  const funded = await funding.fund(opportunity.record);
  if (!funded.ok) return funded;

  if (funded.value.state === "existing") return { ok: true, value: { status: "existing", ...funded.value,
    note: "This grant is not reissued. Inspect its prior outcome; a retry requires a different explicit grant identity." } };

  return withWorkflowLearningSignal(ctx, signal => workWorkflowImprovement({ ...services, scope, budgetId, allowance: tokens.value,
    sessionId: opportunity.record.opportunity.opportunityId, now: ctx.now, newModel: model.value.newModel, publicData: model.value.publicData,
    warn: code => ctx.stderr(`warning: workflow_learning:${code}\n`),
    readEvidence: async () => workflowFailure("workflow_read_not_available", "The worker uses immutable recorded evidence") }, funded.value, opportunity.record, signal));
}

/** One actual terminal choice is the user's action. Model-facing tools have no equivalent operation. */
async function userFeedback(ctx: CliContext, useId: string, noteFile?: string): Promise<WorkflowLearningResult<unknown>> {
  if (!ctx.stdinIsTty || ctx.userSourceAvailable === false) return workflowFailure("workflow_user_source_required", "Subjective user feedback requires the host's interactive user channel");

  const boardRoot = workflowBoardRoot(ctx), view = await readWorkflowImprovements(boardRoot, workspaceIdentity(ctx.cwd), ctx.cwd);
  if (!view.ok) return view;

  const record = view.value.uses.find(item => item.use.useId === useId);
  const version = view.value.versions.find(item => item.versionId === record?.use.versionId);
  if (record === undefined || version === undefined) return workflowFailure("workflow_use_unavailable", "No frozen use exists in this workspace");

  let note = "Explicit terminal user assessment";

  if (noteFile !== undefined) {
    const supplied = ctx.readFile(path.resolve(ctx.cwd, noteFile));
    if (supplied === undefined || supplied.trim().length === 0 || supplied.length > 2000 || !workflowImprovementPublicData(supplied, [])) {
      return workflowFailure("workflow_usage", "The optional note must be readable, public and at most 2000 characters");
    }
    note = supplied;
  }

  const source = await workflowSessionEvidence(ctx, record.sessionId);
  if (!source.ok) return source;

  const observed = userFeedbackExecutions(source.value.records, record.sessionId, record.afterSequence);
  if (!observed.ok) return observed;

  const executions = observed.value;
  const candidates = [...executions.keys()];
  if (candidates.length === 0) return workflowFailure("workflow_user_execution_unavailable",
    "Only guidance exposure is recorded; no post-adoption business receipt identifies an actual execution. Express an opinion through ordinary user correction.");

  const workflowName = JSON.stringify(version.artifact.proposal.procedure.name);
  const prompt = candidates.length === 1
    ? `Workflow ${workflowName}, use ${JSON.stringify(useId)}, actual execution ${JSON.stringify(candidates[0])}: helped / harmed / neutral / cancel? `
    : `Workflow ${workflowName}, use ${JSON.stringify(useId)}. Select the actual execution and your assessment in one answer:\n${candidates.map((id, index) => `${index + 1}) ${JSON.stringify(id)}`).join("\n")}\nEnter '<number> helped', '<number> harmed', '<number> neutral', or cancel: `;
  const answer = (await ctx.readLine(prompt))?.trim(), choice = /^([1-9]\d*)\s+(helped|harmed|neutral)$/.exec(answer ?? "");
  const executionId = candidates[choice === null ? 0 : Number(choice[1]) - 1];
  const judgment = choice?.[2] ?? (candidates.length === 1 ? answer : undefined);
  if (executionId === undefined || judgment !== "helped" && judgment !== "harmed" && judgment !== "neutral") {
    return workflowFailure("cancelled", "No execution-bound user assessment was recorded");
  }

  const previous = view.value.feedback.filter(item => item.useId === useId && item.executionId === executionId).at(-1);
  const feedbackId = ctx.newId("workflow-user-assessment");
  const parsed = parseWorkflowImprovementFeedback({ feedbackId, useId, versionId: version.versionId, task: record.use.task,
    executionId, exposure: previous?.exposure ?? "reported_used",
    quality: "unknown", evidenceRefs: [...executions.get(executionId)!].slice(-32), followedStepIds: [], explanation: note,
    userAssessment: { judgment, evidenceRef: feedbackId } });
  if (!parsed.ok) return parsed;

  const saved = await commitWorkflowImprovementRecord(boardRoot, { type: "workflow_improvement_feedback", schemaVersion: 1, feedback: parsed.value }, new Date(ctx.now()).toISOString());
  if (saved.ok) await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: ctx.cwd, reason: "workflow_user_feedback_committed",
    sourceRefs: [saved.value.versionId, feedbackId, useId] });

  return saved.ok ? { ok: true, value: { feedback: parsed.value,
    reputation: workflowImprovementReputation(version.artifact, [...view.value.feedback, parsed.value], version.versionId, record.use.task) } } : saved;
}

/** A freeze is exposure, not execution. Reuse only canonical paired business receipts after it. */
function userFeedbackExecutions(records: readonly SessionRecord[], sessionId: string, afterSequence: number): WorkflowLearningResult<Map<string, Set<string>>> {
  const turns = new Map<string, SessionRecord[]>(), executions = new Map<string, Set<string>>();

  for (const item of records) if (item.sessionId === sessionId && item.turnId !== undefined) {
    const facts = turns.get(item.turnId) ?? [];
    facts.push(item);
    turns.set(item.turnId, facts);
  }

  for (const facts of turns.values()) {
    if ((facts.at(-1)?.sequence ?? 0) <= afterSequence) continue;
    const projected = projectWorkflowImprovementEvidence(facts, sessionId);
    if (!projected.ok) return projected;
    for (const receipt of projected.value.receipts) if (receipt.sequence > afterSequence) {
      const refs = executions.get(receipt.executionId) ?? new Set<string>();
      refs.add(receipt.ref);
      executions.set(receipt.executionId, refs);
    }
  }

  return { ok: true, value: executions };
}
