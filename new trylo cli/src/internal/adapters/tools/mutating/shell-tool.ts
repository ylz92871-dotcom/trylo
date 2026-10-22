import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import { ShellIsolationError } from "../../../ports/isolation.js";
import { errorCodeOf } from "../../../contract/index.js";
import { DEFAULT_MAX_SHELL_OUTPUT_BYTES, DEFAULT_MAX_SHELL_OUTPUT_LINES, DEFAULT_SHELL_TIMEOUT_MS } from "../../sandbox/policy.js";
import type { MutationPlan, ShellPlan, ShellStep } from "../../sandbox/planner.js";
import { readRunInBackground, startBackgroundShell } from "./background-shell.js";
import type { ShellSpawner } from "./shell-spawn.js";
import type { ProcessSessionRegistry } from "../../process-session/session-registry.js";
import { publishShellStdout, type StdoutFileWriter } from "./shell-stdout-file.js";
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, timeoutRecoveryHelp } from "./shell-timeout-policy.js";
import { truncateOutput } from "./output-limits.js";

/**
 * `run_shell`.
 *
 * The command that runs is the command that was approved: the same plan that
 * satisfied the sandbox is what gets spawned, with no re-reading of a string by
 * an interpreter along the way. An abort ends as `cancelled`, because someone
 * stopped it. A timeout ends as a typed failure, because nobody stopped
 * anything — the clock did — and reporting it as cancelled would read exactly
 * like the person pressing Ctrl-C.
 *
 * Composition is structural rather than syntactic. `steps` runs commands in
 * order and a `|` joins segments into one pipeline, so neither is an excuse to
 * admit `&&`, `;`, redirections or substitutions — every word still went
 * through the same tokenizer and the same refusal rules on the way in.
 */

export { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./shell-timeout-policy.js";

export type ShellRunnerConfig = {
  readonly spawner: ShellSpawner;
  readonly stdoutWriter?: StdoutFileWriter;
  /**
   * Where a command that was asked to keep running goes.
   *
   * Absent means backgrounding is not available, and `runInBackground` is
   * refused rather than quietly run in the foreground — a caller that asked for
   * a session and got a blocking call would wait for a thing that will never
   * finish on its own.
   */
  readonly sessions?: ProcessSessionRegistry | undefined;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputLines?: number;
  /**
   * The machine the commands run on. A seam with a default rather than a bare
   * ambient read, so the guidance a failure carries can be asserted for a
   * platform other than the one running the test.
   */
  readonly platform?: NodeJS.Platform | undefined;
};

/**
 * What the model should do about a command that could not be started.
 *
 * `ENOENT` is the case the real-model run hit: it asked for `cat`, which does
 * not exist on Windows, and `spawn cat ENOENT` told it nothing it could act on,
 * so the next iteration asked for `cat` again. The OS error already names the
 * program, and it is the only thing that knows which half of a pipe failed, so
 * this adds the part the error cannot: where to go instead.
 */
function spawnFailureHelp(err: unknown, platform: NodeJS.Platform): string {
  if (errorCodeOf(err) !== "ENOENT") {
    return "";
  }
  return `\nThe program could not be started on this machine (${platform}): only programs installed here can run, so a POSIX utility (cat, grep, sed, head) may not be one of them. Read a file with read_file, change one with edit_file or write_file, and run the project's own test command (for example 'npm test') to verify.`;
}

function isShellPlan(plan: MutationPlan): plan is ShellPlan {
  return plan.tool === "run_shell";
}

export function readTimeoutArgument(request: ToolCallRequest): number | undefined {
  const value = request.arguments["timeoutMs"];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The whole request as one line, so a failure says what was actually asked. */
function describeStep(step: ShellStep): string {
  const parts = [step.argv.join(" ")];
  let receiver = step.pipeTo;
  while (receiver !== undefined) {
    parts.push(receiver.argv.join(" "));
    receiver = receiver.pipeTo;
  }
  return parts.join(" | ");
}

function describePlan(plan: ShellPlan): string {
  const steps = plan.steps.length > 0 ? plan.steps : [{ executable: plan.executable, argv: plan.argv, shape: plan.shape }];
  return steps.map((step) => describeStep(step)).join(" ; ");
}

function buildOutput(value: {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}): string {
  const body = value.stderr.length === 0 ? value.stdout : `${value.stdout}\n[stderr]\n${value.stderr}`;
  return value.truncated ? `${body}\n[truncated]` : body;
}

export async function executeShell(
  config: ShellRunnerConfig,
  request: ToolCallRequest,
  plan: MutationPlan,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (!isShellPlan(plan)) {
    return { outcome: "error", code: "invalid_arguments", message: "run_shell received a foreign plan" };
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const requested = readTimeoutArgument(request);
  if (requested !== undefined && (requested < MIN_TIMEOUT_MS || requested > MAX_TIMEOUT_MS)) {
    return {
      outcome: "error",
      code: "invalid_arguments",
      message: `run_shell timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    };
  }
  const timeoutMs = requested ?? config.defaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  if (readRunInBackground(request) === true) {
    // Checked after the plan and the abort, so a background command is still one
    // the sandbox approved and still refuses to start on an aborted turn.
    return await startBackgroundShell(
      {
        sessions: config.sessions,
        maxBufferBytes: config.maxOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_BYTES,
      },
      plan,
    );
  }
  const steps = plan.steps.length > 0 ? plan.steps : [{ executable: plan.executable, argv: plan.argv, shape: plan.shape }];
  if (plan.stdoutFile === undefined) return runSteps(config, plan, steps, timeoutMs, signal);
  if (config.stdoutWriter === undefined) return { outcome: "error", code: "stdout_writer_unavailable", message: "stdoutFile writer is not mounted; no stdout file was published" };
  const outcome = await runSteps(config, plan, steps, timeoutMs, signal);
  if (outcome.outcome !== "result") return outcome;
  if (outcome.truncated) return { outcome: "error", code: "stdout_truncated", message: "stdoutFile was not published because command output was truncated; use a producer that writes its own file for large outputs" };
  const stdout = outcome.value["stdout"];
  if (typeof stdout !== "string") return { outcome: "error", code: "stdout_unavailable", message: "command did not return text stdout; no stdout file was published" };
  const written = await publishShellStdout(config.stdoutWriter, request.toolCallId, plan.stdoutFile, stdout, signal);
  if (written.outcome !== "result") return written;
  return { ...outcome, value: { ...outcome.value, ...written.value }, output: `${outcome.output}\n${written.output}` };
}

/** A `pipeTo` chain as the spawner's ordered receivers, head first. */
function receiversOf(head: ShellStep): Array<{ readonly argv: ReadonlyArray<string>; readonly shape: ShellStep["shape"] }> {
  const receivers: Array<{ readonly argv: ReadonlyArray<string>; readonly shape: ShellStep["shape"] }> = [];
  let receiver: ShellStep | undefined = head;
  while (receiver !== undefined) {
    receivers.push({ argv: receiver.argv, shape: receiver.shape });
    receiver = receiver.pipeTo;
  }
  return receivers;
}

async function runSteps(
  config: ShellRunnerConfig,
  plan: ShellPlan,
  steps: readonly ShellStep[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const platform = config.platform ?? process.platform;
  const limits = { maxBytes: config.maxOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_BYTES, maxLines: config.maxOutputLines ?? DEFAULT_MAX_SHELL_OUTPUT_LINES };
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let completedSteps = 0;
  let result;
  for (const step of steps) {
    try {
      result = await config.spawner({
        argv: step.argv,
        cwd: plan.cwd,
        timeoutMs,
        signal,
        maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_BYTES,
        maxOutputLines: config.maxOutputLines ?? DEFAULT_MAX_SHELL_OUTPUT_LINES,
        shape: step.shape,
        ...(step.pipeTo === undefined ? {} : { pipeTo: receiversOf(step.pipeTo) }),
      });
    } catch (err) {
      if (signal.aborted) {
        return { outcome: "cancelled" };
      }
      const detail = err instanceof Error ? err.message : "spawn_error";
      const code = err instanceof ShellIsolationError ? err.code : "shell_spawn_failed";
      return {
        outcome: "error",
        code,
        message: `${code}:command ${JSON.stringify(step.argv[0] ?? "")}: ${detail}\n` +
          `${completedSteps} prior steps completed; later steps were not run. Check earlier effects before retrying the whole workflow.\n` +
          buildOutput({ stdout, stderr, truncated }) + spawnFailureHelp(err, platform),
      };
    }
    if (result.aborted || signal.aborted) {
      return { outcome: "cancelled" };
    }
    // A sequence is one tool call. Earlier diagnostics and loss flags belong
    // to its result even when a later step succeeds or fails.
    const capturedStdout = truncateOutput(stdout + result.stdout, limits);
    const capturedStderr = truncateOutput(stderr + result.stderr, limits);
    stdout = capturedStdout.text;
    stderr = capturedStderr.text;
    truncated ||= result.truncated || capturedStdout.truncated || capturedStderr.truncated;
    if (result.timedOut) {
      // The clock killed it, not a person: a typed failure the model can act
      // on, carrying what the command managed to say
      // before it died. Reporting this as `cancelled` ended the whole turn as
      // "the user stopped it" — the hard-eval D7-① guise.
      const partial = buildOutput({ stdout, stderr, truncated });
      return {
        outcome: "error",
        code: "shell_timeout",
        message: `shell_timeout:${timeoutMs}ms exceeded by ${describePlan(plan)}\n${partial}\n${timeoutRecoveryHelp(timeoutMs)}`,
      };
    }
    if (result.exitCode !== 0) {
      break;
    }
    completedSteps += 1;
  }
  if (result === undefined) {
    return { outcome: "error", code: "invalid_arguments", message: "run_shell requires a non-empty command" };
  }
  const value = {
    command: describePlan(plan),
    exitCode: result.exitCode,
    stdout,
    stderr,
    truncated,
  };
  const output = buildOutput(value);
  if (result.exitCode !== 0) {
    return {
      outcome: "error",
      code: "shell_nonzero_exit",
      message: `shell_nonzero_exit:${result.exitCode}\n${output}\nThe command exited ${result.exitCode}: it failed, and its output above is the evidence. A command that failed is not the task being finished, so read the output before deciding what to do next.`,
    };
  }
  return { outcome: "result", value, output, truncated };
}
