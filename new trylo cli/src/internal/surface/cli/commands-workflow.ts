import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import type { CliSink } from "./render.js";
import type {
  WorkflowListOptions,
  WorkflowRunOptions,
  WorkflowShowOptions,
} from "./args-workflow.js";
import { findWorkflow, loadWorkflows, type Workflow } from "./workflow-store.js";
import { tryloHome } from "./session-paths.js";
import { reportFailure } from "./run-failure.js";

/**
 * `workflow list|show|run` handlers (WP24.2 / A08).
 *
 * `list` / `show` are read-only. `run` loads the workflow body and executes
 * it through the existing run command — the workflow file is a prompt, so
 * the turn it produces carries the run pipeline's own permission, budget,
 * session and exit facts. There is deliberately no workflow executor here:
 * the old engine's files are absent (see `workflow-store.ts`), and a
 * second executor would be a second source of execution truth.
 */

function workflowDirs(ctx: CliContext): { readonly projectDir: string; readonly userDir: string } {
  return {
    projectDir: `${ctx.cwd}/.trylo/workflows`,
    userDir: `${tryloHome(ctx.homeDir, ctx.env)}/workflows`,
  };
}

export function loadWorkflowsFor(ctx: CliContext): ReadonlyArray<Workflow> {
  return loadWorkflows(
    {
      readDir: (dir) => ctx.readDir(dir).map((entry) => ({ name: entry.name })),
      readFile: (path) => ctx.readFile(path),
    },
    workflowDirs(ctx),
  );
}

export function handleWorkflowList(ctx: CliContext, options: WorkflowListOptions): ExitCode {
  const workflows = loadWorkflowsFor(ctx);

  if (options.json) {
    ctx.stdout(
      `${JSON.stringify({ workflows: workflows.map((item) => ({ name: item.name, description: item.description, source: item.source })) })}\n`,
    );
    return EXIT_CODES.OK;
  }

  if (workflows.length === 0) {
    ctx.stdout("no workflows installed\n");
    return EXIT_CODES.OK;
  }

  for (const item of workflows) {
    ctx.stdout(`${item.name}  [${item.source}]  ${item.description}\n`);
  }

  return EXIT_CODES.OK;
}

export function handleWorkflowShow(ctx: CliContext, options: WorkflowShowOptions): ExitCode {
  const found = findWorkflow(loadWorkflowsFor(ctx), options.name);
  if (found === undefined) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `no such workflow: ${options.name}`,
      hint: "`trylo workflow list` shows the runnable ones",
    });
  }

  if (options.json) {
    ctx.stdout(
      `${JSON.stringify({ workflow: { name: found.name, description: found.description, source: found.source }, prompt: found.prompt })}\n`,
    );
    return EXIT_CODES.OK;
  }

  ctx.stdout(`${found.prompt}\n`);

  return EXIT_CODES.OK;
}

export async function handleWorkflowRun(ctx: CliContext, options: WorkflowRunOptions, sink: CliSink): Promise<ExitCode> {
  if (options.name.startsWith("wfl_")) {
    const { handleLearnedWorkflowRun } = await import("./commands-workflow-learned-run.js");
    return handleLearnedWorkflowRun(ctx, options, sink);
  }

  const found = findWorkflow(loadWorkflowsFor(ctx), options.name);
  if (found === undefined) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `no such workflow: ${options.name}`,
      hint: "`trylo workflow list` shows the runnable ones",
    });
  }

  // The run is loaded lazily for the same reason `commands.ts` loads it
  // lazily: `list` and `show` must never pay for — or be broken by — the
  // execution graph.
  const { handleRun } = await import("./run-command.js");

  return handleRun(
    ctx,
    {
      ...options.run,
      message: [found.prompt, ...options.run.message],
    },
    sink,
  );
}
