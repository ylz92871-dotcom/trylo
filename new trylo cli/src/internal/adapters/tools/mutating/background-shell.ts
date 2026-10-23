import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import { MIN_PROCESS_YIELD_MS } from "../../../ports/process-session.js";
import type { ProcessSessionRegistry } from "../../process-session/session-registry.js";
import type { ShellPlan } from "../../sandbox/planner.js";
import { childEnvironment } from "./shell-spawn.js";

/**
 * `run_shell` with `runInBackground`: the command keeps running after the call
 * returns, and the model gets a session id to continue it with.
 *
 * # Why this is a branch rather than a mode
 *
 * The foreground path spawns and waits, and its result is the command's exit
 * code. A background command has no exit code yet — that is the whole point — so
 * it cannot produce that result and pretending otherwise would report a
 * fabricated outcome. It goes to the session registry instead, which is the one
 * place that can answer "what has become of it".
 *
 * The alternative was extending `ShellSpawner` with a "start and detach" mode.
 * That was rejected: the spawner is a single-ownership contract — one call, one
 * settled result — and a second mode would mean two places that own a child's
 * lifetime, which is how a process ends up with nobody waiting for it.
 */

/** A background command is a single command; composition stays in the foreground. */
const MAX_BACKGROUND_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1_000;

export type BackgroundShellConfig = {
  readonly sessions: ProcessSessionRegistry | undefined;
  /** Where a session's output is capped. Matches the foreground path's cap. */
  readonly maxBufferBytes: number;
};

export function readRunInBackground(request: ToolCallRequest): boolean | undefined {
  const value = request.arguments["runInBackground"];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}

/**
 * Start a planned command as a session, or say why it cannot.
 *
 * The argv is the plan's own — the same one the sandbox approved and the same
 * one the foreground path would have spawned. Nothing is re-parsed here: a
 * second reading of the model's bytes is a second answer to "what runs", which
 * is the mistake `planShell` exists to prevent.
 */
export async function startBackgroundShell(
  config: BackgroundShellConfig,
  plan: ShellPlan,
): Promise<ToolOutcome> {
  const registry = config.sessions;
  if (registry === undefined) {
    // Refused rather than run in the foreground. A caller that asked for a
    // session and received a blocking call would wait for something that has no
    // way to finish, and the timeout it eventually hits would look like the
    // command being slow.
    return {
      outcome: "error",
      code: "background_not_available",
      message:
        "runInBackground was asked for but this run has no process-session registry; " +
        "omit it to run in the foreground, where a timeout is reported as a timeout",
    };
  }

  if (plan.steps.length > 1 || plan.steps.some(step => step.pipeTo !== undefined)) {
    // A chain of commands has no single exit code and no single output stream, so
    // there is nothing to hand back as "the" session. Saying so is better than
    // starting the first one and reporting it as the whole.
    return {
      outcome: "error",
      code: "background_single_command_only",
      message:
        "runInBackground accepts one command without a pipeline or steps. " +
        "Use the foreground pipeline, or start a script that owns the full workflow as one background command. No process was started.",
    };
  }

  // The whole interpreted command is already approved as one argv. Its shape
  // only chooses Windows quoting: PowerShell and POSIX shells use "direct"
  // too, so that flag cannot decide whether an interpreted command exists.
  const head = plan.steps[0] ?? (plan.argv.length > 0 ? { argv: [...plan.argv] } : undefined);
  if (head === undefined) {
    return { outcome: "error", code: "empty_command", message: "run_shell requires a non-empty command" };
  }

  let session;
  try {
    session = await registry.start({
      id: "",
      argv: head.argv,
      cwd: plan.cwd,
      // The same environment the foreground path would have handed the spawner.
      // A background command that inherited something different from a
      // foreground one would be a difference nobody asked for and nobody could
      // see.
      env: { ...childEnvironment() },
      tty: false,
      rows: 24,
      cols: 80,
      maxBufferBytes: config.maxBufferBytes,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "spawn_failed";
    return {
      outcome: "error",
      code: "background_start_failed",
      message: `background_start_failed:${detail}`,
    };
  }

  const value = {
    sessionId: session.id,
    command: head.argv.join(" "),
    status: session.status,
    tty: false,
  };
  return {
    outcome: "result",
    value,
    output:
      `Started in the background as session ${session.id}.\n` +
      `Continue it with write_stdin(sessionId="${session.id}"); ` +
      `an empty chars polls for output without sending anything, and stop_process ends it.`,
    truncated: false,
  };
}

/** Exported so `shell-tool` can report the same bounds the registry enforces. */
export { MIN_PROCESS_YIELD_MS, MAX_BACKGROUND_TIMEOUT_MS };
