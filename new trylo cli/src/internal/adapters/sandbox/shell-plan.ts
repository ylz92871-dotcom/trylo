/**
 * Planning `run_shell` (WP05 C06/C07/L17/L19), direct and interpreted.
 *
 * Split out of `planner.ts` under that file's size gate: every helper here
 * serves only shell planning. The rule this file exists to enforce: the
 * command that runs is the command that was approved, so the interpreter
 * decision happens at *plan* time, never at spawn time. A spawner that
 * re-read the string would answer "what runs" a second time, and the two
 * answers would agree right up until the day they did not.
 *
 * Under a shell the string is never tokenized: handing it to the tokenizer
 * first and the interpreter second would subject one command to two admission
 * stories. `steps`/`pipeTo` are this package's composition and are refused
 * here rather than run twice.
 */

import type { SandboxPolicy, ToolCallRequest } from "../../ports/tools.js";
import { planShellPipeline, planWorkingDirectory } from "./command.js";
import { shapeCommand } from "./executable.js";
import type { MutationPlanResult, ShellCommand, ShellStep } from "./planner.js";
import { compositionRefusal, shellModeShape, type ShellModeResult } from "./shell-mode.js";
import { resolveWriteTarget } from "../tools/shared/workspace.js";

function deny(code: string, message: string): MutationPlanResult {
  return { ok: false, code, message };
}

/** `undefined` when absent, `null` when present but not a usable value. */
function readOptionalText(call: ToolCallRequest, key: string): string | null | undefined {
  const value = call.arguments[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSteps(call: ToolCallRequest): readonly string[] | null | undefined {
  const value = call.arguments["steps"];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const steps: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return null;
    }
    steps.push(entry);
  }
  return steps;
}

function planStep(
  policy: SandboxPolicy,
  text: string,
): { readonly ok: true; readonly step: ShellStep } | { readonly ok: false; readonly code: string; readonly message: string } {
  const pipeline = planShellPipeline(policy, text);
  if (!pipeline.ok) {
    return { ok: false, code: pipeline.code, message: pipeline.message };
  }
  // Linked tail-first: the last segment has no receiver, each earlier one
  // receives into the next. A lone command is a chain of one, exactly the
  // shape every existing caller already handles.
  let chained: ShellStep | undefined;
  for (let index = pipeline.segments.length - 1; index >= 0; index -= 1) {
    const segment = pipeline.segments[index];
    if (segment === undefined) {
      return { ok: false, code: "empty_command", message: "run_shell requires a non-empty command" };
    }
    const shape = shapeCommand(segment.argv);
    if (!shape.ok) {
      return { ok: false, code: shape.code, message: shape.message };
    }
    const command: ShellCommand = { executable: segment.executable, argv: segment.argv, shape: shape.shape };
    chained = chained === undefined ? command : { ...command, pipeTo: chained };
  }
  if (chained === undefined) {
    return { ok: false, code: "empty_command", message: "run_shell requires a non-empty command" };
  }
  return { ok: true, step: chained };
}

/** Appends a receiver at the end of a chain, so `pipeTo` extends an inline pipeline. */
function appendReceiver(head: ShellStep, receiver: ShellCommand): ShellStep {
  if (head.pipeTo === undefined) {
    return { ...head, pipeTo: receiver };
  }
  return { ...head, pipeTo: appendReceiver(head.pipeTo, receiver) };
}

function planCwd(
  policy: SandboxPolicy,
  call: ToolCallRequest,
): { readonly ok: true; readonly absolutePath: string } | { readonly ok: false; readonly code: string; readonly message: string } {
  const requested = readOptionalText(call, "cwd");
  if (requested === null) {
    return { ok: false, code: "invalid_arguments", message: "run_shell cwd must be a non-empty path" };
  }
  if (requested === undefined) {
    return { ok: true, absolutePath: policy.workspaceRoot };
  }
  const verdict = planWorkingDirectory(policy.workspaceRoot, requested, policy.fileAccess, policy.workspaceAlias);
  return verdict.ok
    ? { ok: true, absolutePath: verdict.absolutePath }
    : { ok: false, code: verdict.code, message: verdict.message };
}

export type ShellStringPlan = {
  readonly command: string;
  readonly cwd: string;
  readonly hasSteps: boolean;
  readonly hasPipeTo: boolean;
  readonly stdoutFile?: string;
};

/**
 * Plan one command string under an already-resolved mode. `none` is not
 * accepted here: the caller keeps the existing direct path byte-identical by
 * never calling this for it, so this function cannot be the thing that
 * changes what a flag-off run does.
 */
export function planShellString(plan: ShellStringPlan, mode: ShellModeResult): MutationPlanResult {
  if (!mode.ok) {
    // A requested shell that is not installed fails the call with its own
    // name on it — never a substitution, per the WP05 acceptance.
    return deny(mode.code, mode.message);
  }
  if (mode.mode.kind === "none") {
    return deny("shell_mode_miswired", "a direct plan reached the shell planner; the caller must keep the direct path");
  }
  const refused = compositionRefusal(plan.hasSteps, plan.hasPipeTo);
  if (refused !== undefined) {
    return deny(refused, "run_shell steps and pipeTo are this package's own composition and are refused under a shell interpreter");
  }
  const shape = shellModeShape(mode.mode, plan.command);
  return {
    ok: true,
    plan: {
      tool: "run_shell",
      executable: shape.argv[0] ?? plan.command,
      argv: [...shape.argv],
      cwd: plan.cwd,
      steps: [],
      shape,
      ...(plan.stdoutFile === undefined ? {} : { stdoutFile: plan.stdoutFile }),
    },
  };
}

export function planShell(policy: SandboxPolicy, call: ToolCallRequest, shellMode?: ShellModeResult): MutationPlanResult {
  const rawCommand = call.arguments["command"];
  if (typeof rawCommand !== "string" || rawCommand.length === 0) {
    return deny("invalid_arguments", "run_shell requires a non-empty command");
  }
  const command = rawCommand;
  const stdoutFile = call.arguments["stdoutFile"];
  if (stdoutFile !== undefined) {
    if (typeof stdoutFile !== "string" || stdoutFile.length === 0) return deny("invalid_arguments", "stdoutFile requires a non-empty workspace-relative file path");
    if (call.arguments["runInBackground"] === true || call.arguments["steps"] !== undefined) return deny("invalid_arguments", "stdoutFile requires one foreground command or pipeline, without steps");
    const destination = resolveWriteTarget(policy.workspaceRoot, stdoutFile, policy.fileAccess, policy.workspaceAlias);
    if (!destination.ok) return deny(destination.code, `stdoutFile target refused: ${destination.code}`);
  }
  const stepsArgument = readSteps(call);
  if (stepsArgument === null) {
    return deny("invalid_arguments", "run_shell steps must be an array of non-empty commands");
  }
  const pipeArgument = readOptionalText(call, "pipeTo");
  if (pipeArgument === null) {
    return deny("invalid_arguments", "run_shell pipeTo must be a non-empty command");
  }
  if (stepsArgument !== undefined && pipeArgument !== undefined) {
    return deny("invalid_arguments", "run_shell accepts steps or pipeTo, not both");
  }
  const cwd = planCwd(policy, call);
  if (!cwd.ok) {
    return deny(cwd.code, cwd.message);
  }
  if (shellMode !== undefined && (!shellMode.ok || shellMode.mode.kind !== "none")) {
    return planShellString(
      { command, cwd: cwd.absolutePath, hasSteps: stepsArgument !== undefined, hasPipeTo: pipeArgument !== undefined, ...(stdoutFile === undefined ? {} : { stdoutFile }) },
      shellMode,
    );
  }
  const steps: ShellStep[] = [];
  for (const text of [command, ...(stepsArgument ?? [])]) {
    const step = planStep(policy, text);
    if (!step.ok) {
      return deny(step.code, step.message);
    }
    steps.push(step.step);
  }
  if (pipeArgument !== undefined) {
    const receiver = planStep(policy, pipeArgument);
    if (!receiver.ok) {
      return deny(receiver.code, receiver.message);
    }
    const [head, ...rest] = steps;
    if (head === undefined) {
      return deny("empty_command", "run_shell requires a non-empty command");
    }
    // `pipeTo` extends the head: with an inline pipeline already there it
    // becomes the last receiver rather than replacing anything.
    steps.splice(0, steps.length, appendReceiver(head, receiver.step), ...rest);
  }
  const head = steps[0];
  if (head === undefined) {
    return deny("empty_command", "run_shell requires a non-empty command");
  }
  return {
    ok: true,
    plan: {
      tool: "run_shell",
      executable: head.executable,
      argv: head.argv,
      cwd: cwd.absolutePath,
      steps,
      shape: head.shape,
      ...(stdoutFile === undefined ? {} : { stdoutFile }),
    },
  };
}
