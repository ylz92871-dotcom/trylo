import { isSkillFocus, skillFailureCode } from "../../learning/agent/subsystems/skill/index.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { HermesSkillControlOptions } from "./args-hermes-skill.js";
import type { CliContext } from "./context.js";
import { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";
import { reportFailure } from "./run-failure.js";
import { observeRunCancellation } from "./run-interrupt.js";

type Runtime = Pick<ReturnType<typeof createHermesSkillRuntime>, "coordination" | "runFocused" | "dispatchFunded" | "close">;

type RuntimeFactory = (ctx: CliContext) => Runtime;

/** Explicit user control over the existing central skill coordinator, never a second scheduler. */
export async function handleSkillControl(ctx: CliContext, options: HermesSkillControlOptions,
  createRuntime: RuntimeFactory = createHermesSkillRuntime): Promise<ExitCode> {
  const write = (result: object, exit: ExitCode): ExitCode => {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, subsystem: "skill", control: options.control, ...result })}\n`);
    return exit;
  };
  const error = (reason: string, exit: ExitCode = EXIT_CODES.EXECUTION_FAILURE) => write({ ok: false, reason }, exit);
  const workspaceRoot = resolveWorkspaceRoot(ctx, options.workspace);
  if (typeof workspaceRoot !== "string") {
    reportFailure(ctx, workspaceRoot);
    return error("workspace_unavailable", workspaceRoot.exitCode);
  }

  let focus: unknown;

  if (options.control === "focus") {
    try {
      const raw = await ctx.readStdin();
      if (raw.length > 32_768) return error("invalid_skill_focus", EXIT_CODES.USAGE);
      focus = JSON.parse(raw);
    } catch { return error("invalid_skill_focus", EXIT_CODES.USAGE); }
    if (!isSkillFocus(focus)) return error("invalid_skill_focus", EXIT_CODES.USAGE);
  }

  const cancellation = options.control === "dispatch" ? observeRunCancellation(ctx) : undefined;
  let runtime: Runtime | undefined;

  try {
    runtime = createRuntime({ ...ctx, cwd: workspaceRoot });

    if (options.control === "issues") {
      const result = await runtime.coordination.inspect(options.issueId);
      return write(result, result.ok ? EXIT_CODES.OK : EXIT_CODES.EXECUTION_FAILURE);
    }

    if (options.control === "focus") {
      if (!isSkillFocus(focus)) return error("invalid_skill_focus", EXIT_CODES.USAGE);
      const result = await runtime.coordination.focus(focus);
      return write(result, result.ok ? EXIT_CODES.OK : EXIT_CODES.EXECUTION_FAILURE);
    }

    const signal = cancellation!.signal;
    const result = options.issueId === undefined ? await runtime.dispatchFunded(signal) : await runtime.runFocused(options.issueId, signal);

    return write(result, signal.aborted || result.ok && result.status === "cancelled" ? EXIT_CODES.CANCELLED
      : !result.ok || result.status === "failed" ? EXIT_CODES.EXECUTION_FAILURE : EXIT_CODES.OK);
  } catch (failure) {
    return error(skillFailureCode(failure, "hermes_skill_control_unavailable"), cancellation?.signal.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.EXECUTION_FAILURE);
  } finally {
    cancellation?.close();
    try { await runtime?.close(); }
    catch { ctx.stderr("warning: hermes_skill_control_close_failed; persisted coordination results remain authoritative\n"); }
  }
}
