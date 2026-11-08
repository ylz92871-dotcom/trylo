import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import { openWorkflowImprovement } from "./workflow-improvement-wiring.js";
import { composeAdditionalTools } from "./additional-tools.js";

export function bindWorkflowImprovement(scaffold: RunScaffold,
  runtime: NonNullable<ReturnType<typeof openWorkflowImprovement>>) {
  return { ...scaffold, workflowFocusedLearning: runtime.focusedLearning,
    ...(runtime.centralExecution === undefined ? {} : { workflowCentralExecution: runtime.centralExecution }),
    additionalTools: scaffold.additionalTools === undefined ? runtime.tools : composeAdditionalTools(scaffold.additionalTools, runtime.tools),
    systemPromptAppend: [scaffold.systemPromptAppend, runtime.prompt].filter(Boolean).join("\n") };
}

/** REPL/TUI have a durable session but no one-shot handleRun wrapper. Share the same workflow owner per turn. */
export function openWorkflowForTurn(ctx: CliContext, scaffold: RunScaffold,
  open: typeof openWorkflowImprovement = openWorkflowImprovement) {
  if ((scaffold.workflowLearning !== true && scaffold.centralLearning === undefined) || scaffold.workflowFocusedLearning !== undefined) return undefined;
  const runtime = open(ctx, scaffold, scaffold.workflowLearningBudget ?? 16000);
  if (runtime === undefined) return undefined;
  return { close: runtime.close, scaffold: bindWorkflowImprovement(scaffold, runtime) };
}
