import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { WorkflowRunOptions } from "./args-workflow.js";
import type { CliContext } from "./context.js";
import type { CliSink } from "./render.js";
import { reportFailure } from "./run-failure.js";

/** The named workflow command is syntax over the same run/stdio lifecycle. */
export async function handleLearnedWorkflowRun(ctx: CliContext, options: WorkflowRunOptions, sink: CliSink): Promise<ExitCode> {
  if (options.task === undefined) return reportFailure(ctx, { exitCode: EXIT_CODES.CONFIG,
    message: "learned workflows require an explicit task context", hint: "pass --task <task.json> before --" });

  const run = { ...options.run, workflowVersion: options.name, workflowTask: options.task,
    message: options.run.message.length === 0 && !options.run.readStdin && options.run.permissionPromptTool !== "stdio"
      ? ["Execute the adopted workflow in this workspace using the supplied task context."] : options.run.message };
  if (run.permissionPromptTool === "stdio") return (await import("./run-stdio.js")).handleStdioRun(ctx, run, sink);

  return (await import("./run-command.js")).handleRun(ctx, run, sink);
}
