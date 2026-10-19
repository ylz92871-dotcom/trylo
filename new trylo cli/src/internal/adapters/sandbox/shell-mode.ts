import type { CommandShape } from "./executable.js";
import {
  defaultShellKind,
  isShellKind,
  needsVerbatimArguments,
  resolveShell,
  shellExecArgv,
  type DetectedShell,
  type ShellEnvironment,
  type ShellKind,
  type ShellLookupFailureCode,
} from "./shell-detect.js";

/**
 * When a command string is handed to a real interpreter.
 *
 * The default is no shell, and that is not a limitation being worked around —
 * it is the property everything else in this package is built on. `run_shell`
 * without this turns a string into an argv, so a `|` is a pipe this package
 * builds and every other operator is refused rather than interpreted. Turning
 * that off is a decision a *run* makes once, in settings, and it is the same
 * decision the two sources make: the legacy CLI reads `settings.defaultShell`
 * (`trylo cli/src/utils/shell/resolveDefaultShell.ts`) and Codex builds one
 * `default_user_shell()` per session (`codex-rs/core/src/session/session.rs:1192`,
 * whose only production setter is `..._for_tests`).
 *
 * It is deliberately NOT a per-call tool argument, and the reason is measured
 * rather than stylistic. A new `run_shell` property changes `parameters`, which
 * changes `toolCatalogHash`, and `session-open.ts:90` then refuses every session
 * recorded before the change. A shell chosen once per run costs no session.
 *
 * What this does NOT do: decide whether a command may run. The sandbox and the
 * permission chain still see the same `run_shell` call and answer it before this
 * module is consulted — a shell decides how a command is *read*, never whether
 * it is *allowed*.
 */

export type ShellMode =
  /** No interpreter: the string becomes an argv and operators are refused. */
  | { readonly kind: "none" }
  /** One interpreter for the whole command string, resolved on this machine. */
  | { readonly kind: "shell"; readonly shell: DetectedShell };

/**
 * The refusals this module can report.
 *
 * The shell-lookup half is not re-declared: `ShellLookupFailureCode` is the
 * canonical vocabulary for "a shell could not be resolved" and this module
 * forwards it unchanged, so a caller switches on one set of names rather than
 * translating between two spellings of the same fact.
 */
export type ShellModeDenyCode = ShellLookupFailureCode | "shell_mode_rejects_composition";

export type ShellModeResult =
  | { readonly ok: true; readonly mode: ShellMode }
  | { readonly ok: false; readonly code: ShellModeDenyCode; readonly message: string };

/**
 * The settings value, narrowed to what this module accepts.
 *
 * `undefined` and `null` both mean "no shell", matching how the legacy CLI
 * treated an absent `defaultShell`: the shipped behaviour, not a special case.
 * An empty or non-string value is a refusal rather than a silent default,
 * because a config that says `shell: ""` has expressed an intent this cannot
 * honour and guessing at it would run commands under an interpreter the user
 * did not choose.
 */
export function readShellSetting(value: unknown): ShellKind | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return isShellKind(value) ? value : null;
}

/**
 * Resolve the run's shell.
 *
 * A named shell that is not installed is a typed failure carrying that name, and
 * never a substitution. Codex's equivalent
 * (`get_shell_by_model_provided_path`, `shell_detect.rs:330`) ends in
 * `unwrap_or_else(ultimate_fallback_shell)`, so a request for a shell this
 * machine lacks quietly runs under `cmd`/`sh` instead; a command written for
 * PowerShell then fails in a way that looks like the user's bug. WP05's
 * acceptance for this line is explicit failure, so that fallback is a deviation
 * recorded here rather than copied.
 */
export function resolveShellMode(
  surface: ShellEnvironment,
  requested: ShellKind | undefined,
): ShellModeResult {
  const kind = requested ?? defaultShellKind(surface);
  const resolved = resolveShell(surface, kind);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, message: resolved.message };
  }
  return { ok: true, mode: { kind: "shell", shell: resolved.shell } };
}

/**
 * The `CommandShape` for a command string under this mode.
 *
 * A `direct` shape is the existing path and is returned unchanged when there is
 * no shell, so a flag-off run produces the byte-identical argv it always did.
 * Under a shell the argv is `[interpreter, ...its own flags, command]` with the
 * command as ONE element: the interpreter does its own parsing, which is the
 * whole reason quoting is not re-applied here.
 */
export function shellModeShape(mode: ShellMode, command: string): CommandShape {
  if (mode.kind === "none") {
    return { kind: "direct", argv: [command] };
  }
  // Only cmd accepts a verbatim command line. PowerShell and POSIX shells
  // need Node to preserve their command string as one quoted argv element.
  return { kind: needsVerbatimArguments(mode.shell) ? "shell" : "direct", argv: [...shellExecArgv(mode.shell, command)] };
}

/**
 * Composition arguments are refused under a shell.
 *
 * `steps` and `pipeTo` are *this package's* composition: they are planned,
 * approved and spawned segment by segment, with each segment separately
 * admissible. Handing them to an interpreter as well would run the same segment
 * twice under two different admission stories, and the stricter one would be the
 * one that was checked. So a run with a shell uses the command string alone.
 */
export function compositionRefusal(
  hasSteps: boolean,
  hasPipeTo: boolean,
): ShellModeDenyCode | undefined {
  return hasSteps || hasPipeTo ? "shell_mode_rejects_composition" : undefined;
}
