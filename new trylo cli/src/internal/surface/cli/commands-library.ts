import { resolve, relative, isAbsolute } from "node:path";
import { parseExpertCommand, ExpertLibraryError } from "../../subagent/experts/index.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import type { LibraryCommandOptions } from "./args-library.js";
import type { CliLibraryCommandHosts } from "./library-command-ports.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { createStdioSession } from "./stdio-session.js";

const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Reuse the existing host's provider, tools, Permission and disposal; no parallel runtime or gesture privilege. */
export async function handleLibraryCommand(ctx: CliContext, options: LibraryCommandOptions): Promise<ExitCode> {
  const write = (value: unknown, code: ExitCode): ExitCode => {
    ctx.stdout(`${JSON.stringify(value ?? null)}\n`);
    return code;
  };
  const error = (reason: string, code: ExitCode = EXIT_CODES.EXECUTION_FAILURE) => write({ ok: false, reason }, code);
  const workspaceRoot = resolve(ctx.cwd, options.workspace ?? ctx.cwd);
  if (!ctx.isDirectory(workspaceRoot)) return error("workspace_unavailable");

  let raw: unknown;

  try { const text = options.permissionPromptTool === "stdio" ? await ctx.readLine() : await ctx.readStdin();
    if (text === undefined || text.length > 131072) return error("invalid_library_command", EXIT_CODES.USAGE);
  raw = JSON.parse(text); }
  catch { return error("invalid_library_command", EXIT_CODES.USAGE); }

  let expert: ReturnType<typeof parseExpertCommand> | undefined;

  if (options.library === "expert") {
    try { expert = parseExpertCommand(raw); }
    catch { return error("invalid_expert_command", EXIT_CODES.USAGE); }
  } else {
    if (!row(raw) || Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "context") || !Object.hasOwn(raw, "command")
      || !row(raw.context) || Object.keys(raw.context).length !== 2 || typeof raw.context.memberId !== "string" || !raw.context.memberId.trim()
      || raw.context.memberId.length > 512 || typeof raw.context.scope !== "string" || !isAbsolute(raw.context.scope)
      || relative(workspaceRoot, resolve(raw.context.scope)) !== "" || !row(raw.command)) return error("invalid_tool_library_context", EXIT_CODES.USAGE);
  }

  if (ctx.libraryHosts === undefined) return error("library_host_unavailable");

  const cancellation = observeRunCancellation(ctx);
  const control = options.permissionPromptTool === "stdio" ? createStdioSession(ctx) : undefined;
  const signal = control === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, control.signal]);

  control?.start();
  let hosts: CliLibraryCommandHosts | undefined;

  try {
    hosts = await ctx.libraryHosts({ workspaceRoot, signal,
      ...(control === undefined ? {} : { approval: { requestApproval: control.approval, supportsMemberApproval: true } }) });

    if (signal.aborted) return error("cancelled", EXIT_CODES.CANCELLED);

    if (options.library === "expert") {
      if (hosts.expert === undefined || expert === undefined) return error("expert_library_unavailable");
      const value = await hosts.expert.execute(expert, { signal });
      return write(value, signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.OK);
    }

    if (hosts.tool === undefined || !row(raw) || !row(raw.context)) return error("tool_library_unavailable");

    const value = await hosts.tool.execute({ memberId: String(raw.context.memberId), scope: workspaceRoot }, raw.command, signal);

    return write(value, signal.aborted ? EXIT_CODES.CANCELLED : row(value) && value.ok === false ? EXIT_CODES.EXECUTION_FAILURE : EXIT_CODES.OK);
  } catch (errorValue) {
    return error(errorValue instanceof ExpertLibraryError ? errorValue.code : "library_command_failed",
      signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE);
  } finally {
    control?.close();
    cancellation.close();
    try { await hosts?.close?.(); }
    catch { ctx.stderr("warning: library host cleanup failed; inspect owned resources before retrying\n"); }
  }
}
