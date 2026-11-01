import path from "node:path";
import type { CliContext } from "./context.js";
import type { ToolLabCommand } from "./args-tools.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { handleRun } from "./run-command.js";
import { openToolCandidateUse, type CandidateUseMount } from "../../integration/tool-learning/evolution-use.js";
import { readToolEvolutionCandidate } from "../../integration/tool-learning/evolution-reader.js";
import { createToolCandidateExecutor } from "../../adapters/tool-evolution/process-executor.js";
import { createWindowsIsolation } from "../../adapters/sandbox/windows-isolation.js";
import { hostNodeExecutable } from "../../adapters/sandbox/executable.js";
import { windowsHelperEnvironment } from "../../adapters/sandbox/windows-helper-environment.js";
import { tryloHome } from "./session-paths.js";

export async function handleToolUse(ctx: CliContext, command: Extract<ToolLabCommand, { kind: "use" }>, boardRoot: string): Promise<ExitCode> {
  const candidate = await readToolEvolutionCandidate(boardRoot, command.versionId);
  if (!candidate.ok) { ctx.stderr(`${candidate.code}: ${candidate.message}\n`); return EXIT_CODES.CONFIG; }
  let mount: CandidateUseMount | undefined;
  try {
    return await handleRun(ctx, command.run, { stdout: ctx.stdout, stderr: ctx.stderr }, undefined, {
      async open(scaffold) {
        if (scaffold.subagentEnabled || scaffold.providerKind === "fixture-subagent" || scaffold.session !== undefined) throw new Error("candidate use requires an ephemeral run with no subagent inheritance");
        const opened = await openToolCandidateUse({ boardRoot, versionId: command.versionId, sessionId: scaffold.sessionId, workspaceId: scaffold.workspaceId,
          now: ctx.now, newId: () => ctx.newId("tool-use"), warn: message => ctx.stderr(`warning: ${message}\n`),
          executor: { execute: async (value, input, signal) => createToolCandidateExecutor({
            isolation: createWindowsIsolation({ hostEnv: windowsHelperEnvironment(ctx.env) }), nodeExecutable: hostNodeExecutable(),
            scratchRoot: path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "tool", "quarantine"),
          }).execute(value, input, signal) } });
        if (!opened.ok) throw new Error(`${opened.code}: ${opened.message}`);
        mount = opened.mount;
        ctx.stderr(`Experimental tool ${mount.binding.name}, frozen version ${command.versionId}\nSource: ${JSON.stringify(mount.source)}\n`);
        return mount.tools;
      },
      close: async () => { await mount?.close(); },
    });
  } catch (error) {
    ctx.stderr(`tool use unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.CONFIG;
  }
}
