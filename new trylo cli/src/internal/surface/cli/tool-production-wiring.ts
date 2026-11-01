import path from "node:path";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import { switchEnablesTool } from "../../integration/user-learning/index.js";
import { openWorkspaceProductionTools } from "../../integration/tool-learning/production-use.js";
import { createToolCandidateExecutor } from "../../adapters/tool-evolution/process-executor.js";
import { createWindowsIsolation } from "../../adapters/sandbox/windows-isolation.js";
import { hostNodeExecutable } from "../../adapters/sandbox/executable.js";
import { windowsHelperEnvironment } from "../../adapters/sandbox/windows-helper-environment.js";
import { tryloHome } from "./session-paths.js";
import { composeAdditionalTools } from "./additional-tools.js";

/** Ordinary run/REPL/TUI share this turn-boundary mount. Learning-off constructs and reads nothing. */
export async function productionToolsForTurn(ctx: Pick<CliContext, "homeDir" | "env" | "now" | "newId" | "stderr" | "toolProduction">,
  scaffold: Pick<RunScaffold, "learning" | "toolSelection" | "workspaceId" | "sessionId" | "additionalTools">) {
  if (scaffold.learning === undefined || !switchEnablesTool(scaffold.learning) || scaffold.toolSelection?.length === 0) return undefined;
  const service = ctx.toolProduction;
  if (service === undefined) { ctx.stderr("warning: production_checker_unavailable: production tools unavailable\n"); return undefined; }
  const home = tryloHome(ctx.homeDir, ctx.env);
  const opened = await openWorkspaceProductionTools({ boardRoot: path.join(home, "learning", "board"), workspaceId: scaffold.workspaceId,
    sessionId: scaffold.sessionId, authority: service.authority, executePlan: service.execute, now: ctx.now, newId: () => ctx.newId("tool-use"),
    warn: message => ctx.stderr(`warning: ${message}\n`), executor: { execute: (candidate, input, signal) => createToolCandidateExecutor({
      isolation: createWindowsIsolation({ hostEnv: windowsHelperEnvironment(ctx.env) }), nodeExecutable: hostNodeExecutable(),
      scratchRoot: path.join(home, "learning", "tool", "quarantine"), profile: "confined_json_function_v1", timeoutMs: 5000,
    }).execute(candidate, input, signal) } });
  if (!opened.ok) { ctx.stderr(`warning: ${opened.code}: production tools unavailable\n`); return undefined; }
  const tools = scaffold.additionalTools === undefined ? opened.tools : composeAdditionalTools(scaffold.additionalTools, opened.tools);
  return { tools, close: opened.close };
}
