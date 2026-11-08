import { resolve } from "node:path";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { PersistentLearnOptions } from "./args-learn.js";
import type { CliContext } from "./context.js";
import type { CliLibraryCommandHosts } from "./library-command-ports.js";
import { observeRunCancellation } from "./run-interrupt.js";

/** The production composition owns PA selection, canonical jobs and the original funding. */
export async function handlePersistentLearn(ctx: CliContext, options: PersistentLearnOptions): Promise<ExitCode> {
  const write = (value: unknown, code: ExitCode): ExitCode => {
    ctx.stdout(`${JSON.stringify(value ?? null)}\n`);
    return code;
  };
  const error = (reason: string, code: ExitCode = EXIT_CODES.EXECUTION_FAILURE) => write({ ok: false, reason }, code);

  if (!options.resume && (options.grant.maxSteps === 0 || options.grant.maxModelCalls === 0 || options.grant.maxModelTokens === 0)) {
    return write({ ok: true, phase: "idle", reason: "zero_allowance" }, EXIT_CODES.OK);
  }

  const workspaceRoot = resolve(ctx.cwd);
  if (!ctx.isDirectory(workspaceRoot)) return error("workspace_unavailable");

  if (ctx.libraryHosts === undefined) return error("collaboration_host_unavailable");

  const cancellation = observeRunCancellation(ctx);
  let hosts: CliLibraryCommandHosts | undefined;

  try {
    hosts = await ctx.libraryHosts({ workspaceRoot, signal: cancellation.signal, purpose: "collaboration" });

    if (cancellation.signal.aborted) return error("cancelled", EXIT_CODES.CANCELLED);

    if (hosts.collaboration === undefined) return error("collaboration_host_unavailable");

    const result = await hosts.collaboration.run(options.resume ? undefined : { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: options.grant.maxModelTokens, maxCalls: options.grant.maxModelCalls, maxSteps: options.grant.maxSteps,
      maxPromptChars: options.grant.maxPromptChars }, cancellation.signal);

    return write(result, cancellation.signal.aborted ? EXIT_CODES.CANCELLED
      : result !== null && typeof result === "object" && "ok" in result && result.ok === true ? EXIT_CODES.OK : EXIT_CODES.EXECUTION_FAILURE);
  } catch { return error("collaboration_command_failed", cancellation.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE); }
  finally {
    cancellation.close();
    try { await hosts?.close?.(); }
    catch { ctx.stderr("warning: collaboration host cleanup failed; inspect owned resources before retrying\n"); }
  }
}
