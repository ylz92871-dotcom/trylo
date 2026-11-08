import path from "node:path";
import { readRuntimeIntent, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import type { RunCommandOptions } from "./args.js";
import type { CliContext } from "./context.js";
import { isCentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { controlCentralRuntimeFor } from "./central-runtime-control.js";
import { tryloHome } from "./session-paths.js";
import { switchEnablesUser } from "../../integration/user-learning/switch.js";

function stoppedRun(options: RunCommandOptions, privateTurn: boolean): RunCommandOptions {
  const { centralLearning: _central, centralLearningThoughtMaxTokens: _thought, learning, skillLearningAllowance: _skill, workflowLearning: _workflow,
    workflowLearningBudget: _workflowBudget, ...base } = options;
  return { ...base, collaborationLearning: "off", workflowCollection: "disabled",
    ...(!privateTurn && switchEnablesUser(learning) ? { learning: "user" as const } : {}) };
}

/** Resolve activation before session preparation, so ordinary subsequent tasks keep a real source journal. */
export async function restoreCentralRuntimeRunOptions(ctx: CliContext, options: RunCommandOptions, workspaceRoot: string): Promise<RunCommandOptions> {
  const policy = options.centralRuntimePolicy;
  if (policy !== undefined) {
    const result = await controlCentralRuntimeFor(ctx, workspaceRoot, policy);
    if (!result.ok) ctx.stderr(`warning: ${result.reason}; runtime control was not confirmed\n`);
  }

  if (policy === "pause" || policy === "stop") {
    return stoppedRun(options, policy === "pause");
  }

  const paths = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), workspaceRoot);
  const saved = readRuntimeIntent(paths);
  if (!saved.ok) {
    ctx.stderr(`warning: ${saved.reason}; saved central configuration was not restored\n`);
    return options;
  }

  if (saved.value?.enabled === false) return stoppedRun(options, false);

  if (saved.value === undefined) return options;

  const configuration = saved.value.configuration;
  if (!isCentralRuntimeConfiguration(configuration)) {
    ctx.stderr("warning: runtime_configuration_invalid\n");
    return options;
  }

  const { centralLearningThoughtMaxTokens: _thought, ...base } = options;

  return { ...base, centralLearning: options.centralLearning ?? configuration.allowance,
    ...(configuration.thoughtMaxTokens === undefined ? {} : { centralLearningThoughtMaxTokens: configuration.thoughtMaxTokens }),
    ...(options.learning !== undefined ? {} : { learning: configuration.userLearning ? "all" as const : "agent" as const }) };
}
