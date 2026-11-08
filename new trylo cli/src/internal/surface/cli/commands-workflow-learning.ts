import path from "node:path";
import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { listWorkflowVersions, readWorkflowVersion, workflowFeedback } from "../../integration/workflow-learning/archive.js";
import { runWorkflowLearning } from "../../integration/workflow-learning/runtime.js";
import { handleWorkflowJobCommand } from "./commands-workflow-jobs.js";
import { handleWorkflowSessionLearning } from "./commands-workflow-session.js";
import { record } from "../../learning/domains/workflow/trace-parse.js";
import { notifyCommittedCentralRuntimeForSource } from "./central-runtime-notify.js";

export { workflowBoardRoot } from "./workflow-paths.js";

export async function handleWorkflowLearning(ctx: CliContext, argv: readonly string[]): Promise<ExitCode> {
  const [verb, target] = argv;
  try {
    let result;

    if (["improvements", "improvement", "improve-work", "improve-user-feedback"].includes(verb ?? "")) {
      result = await (await import("./commands-workflow-improvement.js")).handleWorkflowImprovementCommand(ctx, argv);
    } else if (["jobs", "job", "recover", "retry", "work"].includes(verb ?? "")) {
      result = await handleWorkflowJobCommand(ctx, argv);
    } else if (verb === "learn-session") {
      result = await handleWorkflowSessionLearning(ctx, argv);
    } else if (verb === "learn" && target !== undefined && argv.length === 2) {
      const raw = ctx.readFile(path.resolve(ctx.cwd, target));
      if (raw === undefined || raw.length > 1048576) throw new Error("learning request is unreadable or exceeds 1 MiB");
      const request: unknown = JSON.parse(raw);
      result = await runWorkflowLearning({ boardRoot: workflowBoardRoot(ctx), request, issuedAt: new Date(ctx.now()).toISOString() });
      if (result.ok) await notifyCommittedCentralRuntimeForSource(ctx, { workspaceRoot: ctx.cwd, reason: "workflow_learning_committed",
        sourceRefs: [result.value.versionId] });
    } else if (verb === "learned" && (argv.length === 1 || (argv.length === 2 && target === "--json"))) {
      result = await listWorkflowVersions(workflowBoardRoot(ctx));
    } else if ((verb === "inspect" || verb === "feedback") && target !== undefined && argv.length === 2) {
      result = verb === "inspect" ? await readWorkflowVersion(workflowBoardRoot(ctx), target) : await workflowFeedback(workflowBoardRoot(ctx), target);
    } else {
      ctx.stderr("trylo workflow learn <request.json> | learned | inspect <version> | feedback <version> | jobs | job <id> | recover <id> --attempt n | retry <id> --grant id --tokens n | work <id> [--prompt-file file] -- <provider flags> | learn-session <session> [--budget n] -- <provider flags>\n");
      return EXIT_CODES.USAGE;
    }

    ctx.stdout(`${JSON.stringify(result)}\n`);

    if (!result.ok) return result.code === "workflow_usage" ? EXIT_CODES.USAGE : EXIT_CODES.CONFIG;

    if (record(result.value) && (result.value.kind === "not_classified" || (record(result.value.outcome)
      && ["failed", "cancelled", "budget_exhausted"].includes(String(result.value.outcome.kind))))) return EXIT_CODES.EXECUTION_FAILURE;

    return EXIT_CODES.OK;
  } catch (error) {
    ctx.stderr(`workflow learning failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.CONFIG;
  }
}
