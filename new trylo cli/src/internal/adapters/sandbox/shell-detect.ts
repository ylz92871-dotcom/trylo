import path from "node:path";

/**
 * Which shell interprets a command string, and what argument vector runs it.
 *
 * Source of the semantics: Codex `codex-rs/shell-command/src/shell_detect.rs`
 * (detect_shell_type, the per-shell lookup order, the WindowsApps exclusion) and
 * `codex-rs/core/src/shell.rs::derive_exec_args` (the argument vector per shell
 * family), both at `73a1148c9c775c2a4616ce5096291740a00ed68a`. The PowerShell
 * exit-code tail is the legacy Trylo CLI's, from
 * `trylo cli/src/utils/shell/powershellProvider.ts`.
 *
 * Every function here is a pure function of an injected environment, and this
 * module reads no ambient source at all: the host's `PATH` and platform arrive
 * as a plain record. That is what makes the detection rules assertable for a
 * platform other than the one running the test — "a machine with no PowerShell
 * fails with `shell_not_installed`" is a fact about an array, not about the
 * machine. The host record is built by `executable.ts`, which already owns
 * reading the platform for this layer.
 *
 * The one thing this module deliberately does NOT do is decide *whether* a
 * command may run. That is the planner's and the permission chain's; this only
 * answers "given that it may, which program interprets it".
 */

export const SHELL_KINDS = ["bash", "zsh", "sh", "powershell", "cmd"] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];

export function isShellKind(value: string): value is ShellKind {
  return (SHELL_KINDS as readonly string[]).includes(value);
}

export type DetectedShell = {
  readonly kind: ShellKind;
  /** Absolute path to the shell program, resolved on this machine. */
  readonly path: string;
};

export type ShellLookupFailureCode =
  | "unknown_shell_kind"
  | "shell_not_installed"
  | "no_shell_available";

/**
 * `ShellKind` is a compile-time union, and that is the only thing stopping a
 * bad name from reaching {@link resolveShell}. It is not enough at a boundary:
 * this module is reachable from settings, from JSON, and from any JavaScript
 * caller, and `PROGRAM_NAMES["pwsh"]` is `undefined` — so indexing it threw
 * `TypeError: PROGRAM_NAMES[kind] is not iterable` out of a function whose whole
 * job is to answer with a typed failure. The check below is what makes
 * `unknown_shell_kind` a code this module can actually produce instead of a
 * member of a union nothing returns.
 */
function isShellKindValue(value: unknown): value is ShellKind {
  return typeof value === "string" && isShellKind(value);
}

export type ShellLookupResult =
  | { readonly ok: true; readonly shell: DetectedShell }
  | { readonly ok: false; readonly code: ShellLookupFailureCode; readonly message: string };

/** The slice of the environment this module is allowed to read. */
export type ShellEnvironment = {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether an absolute path exists. Injected so the rules can be tested. */
  readonly fileExists: (absolutePath: string) => boolean;
};

/**
 * The name a shell is *asked for* is not the name it is *called*: `pwsh` and
 * `powershell.exe` are the same shell, and `/usr/bin/bash` is `bash`. Matching
 * on the file stem and then on the bare name is what lets one rule cover every
 * spelling a user or a PATH search can produce.
 *
 * Codex does this by stripping the extension and re-testing the stem; the
 * recursion terminates because a stem never grows a new suffix.
 */
export function detectShellKind(programName: string): ShellKind | undefined {
  const base = path.basename(programName).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  switch (base) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "sh":
      return "sh";
    case "pwsh":
    case "powershell":
      return "powershell";
    case "cmd":
      return "cmd";
    default:
      return undefined;
  }
}

/**
 * The program names a shell kind answers to, most preferred first.
 *
 * The order is a preference, not a fact: `pwsh` before `powershell` because
 * PowerShell 7 is the one that behaves the way this contract describes, and
 * `cmd` last because it is the fallback that exists on every Windows machine
 * and therefore the one most likely to be present *and* wrong.
 */
const PROGRAM_NAMES: Readonly<Record<ShellKind, ReadonlyArray<string>>> = {
  bash: ["bash"],
  zsh: ["zsh"],
  sh: ["sh"],
  powershell: ["pwsh", "powershell"],
  cmd: ["cmd"],
};

/**
 * Absolute paths tried when PATH does not have the program.
 *
 * The PowerShell 5.1 path is the one Windows itself installs, so it is the
 * difference between "PowerShell works" and "PowerShell works if the user has
 * upgraded", which is not a distinction worth making by default.
 */
const FALLBACK_PATHS: Readonly<Record<ShellKind, ReadonlyArray<string>>> = {
  bash: ["/bin/bash", "/usr/bin/bash"],
  zsh: ["/bin/zsh", "/usr/bin/zsh"],
  sh: ["/bin/sh"],
  powershell: [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ],
  cmd: ["C:\\Windows\\System32\\cmd.exe"],
};

function searchPath(surface: ShellEnvironment): ReadonlyArray<string> {
  const raw = surface.env["PATH"];
  if (typeof raw !== "string") {
    return [];
  }
  return raw.split(path.delimiter).filter((entry) => entry.length > 0);
}

function firstExisting(
  surface: ShellEnvironment,
  candidates: ReadonlyArray<string>,
): string | undefined {
  for (const candidate of candidates) {
    if (candidate.length > 0 && surface.fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function onPath(surface: ShellEnvironment, program: string): string | undefined {
  const extensions =
    surface.platform === "win32"
      ? (surface.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.length > 0)
      : [""];
  for (const directory of searchPath(surface)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${program}${extension}`);
      if (surface.fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Find one named shell.
 *
 * PATH first, then the install locations: a shell the user put on PATH is the
 * one they meant, and the fallback list only answers "is there any of this
 * here at all". A named shell that is not installed is a typed failure with
 * that name in it — never a silent substitution, because a command written for
 * PowerShell and run under `cmd` fails in a way that looks like the user's bug.
 *
 * The `kind` is re-checked at runtime even though its type says it cannot be
 * wrong, because this is a boundary function: its callers include settings
 * parsing and arbitrary JavaScript, where a name that is not a `ShellKind`
 * arrives as a string. Measured before the check existed —
 * `resolveShell(host, "pwsh")` threw `TypeError: PROGRAM_NAMES[kind] is not
 * iterable` out of the middle of the lookup, which is the one shape this package
 * is not allowed to have. A typed refusal is the answer, and it is the answer
 * the failure union has carried `unknown_shell_kind` for since it was written.
 */
export function resolveShell(surface: ShellEnvironment, kind: ShellKind): ShellLookupResult {
  if (!isShellKindValue(kind)) {
    return {
      ok: false,
      code: "unknown_shell_kind",
      message: `No such shell: ${JSON.stringify(kind)}. This build knows ${SHELL_KINDS.join(", ")}.`,
    };
  }
  for (const program of PROGRAM_NAMES[kind]) {
    const found = onPath(surface, program);
    if (found !== undefined) {
      return { ok: true, shell: { kind, path: found } };
    }
  }
  const fallback = firstExisting(surface, FALLBACK_PATHS[kind]);
  if (fallback !== undefined) {
    return { ok: true, shell: { kind, path: fallback } };
  }
  return {
    ok: false,
    code: "shell_not_installed",
    message:
      kind === "powershell"
        ? "No PowerShell on this machine: neither pwsh nor powershell was found on PATH or at its install location. Install PowerShell, or run the command with a shell that exists here."
        : `No ${kind} on this machine: it was not found on PATH or at its usual install location.`,
  };
}

/**
 * The shell used when the caller did not name one.
 *
 * Deliberately not the user's `SHELL` variable: this picks the interpreter for
 * a command the *model* wrote, and inheriting an interactive login shell's
 * configuration would make the result depend on whose session is running it.
 * Windows gets PowerShell and Unix gets `sh` because both exist on their
 * platform by definition, so the default cannot fail for want of a shell.
 */
export function defaultShellKind(surface: ShellEnvironment): ShellKind {
  return surface.platform === "win32" ? "powershell" : "sh";
}

export function resolveDefaultShell(surface: ShellEnvironment): ShellLookupResult {
  const preferred = defaultShellKind(surface);
  const resolved = resolveShell(surface, preferred);
  if (resolved.ok) {
    return resolved;
  }
  // The preferred shell is missing. cmd on Windows and bash elsewhere are the
  // last resorts that still exist on a stock install, and the failure is only
  // reported when neither does.
  const ultimate: ShellKind = surface.platform === "win32" ? "cmd" : "sh";
  const fallback = resolveShell(surface, ultimate);
  if (fallback.ok) {
    return fallback;
  }
  return {
    ok: false,
    code: "no_shell_available",
    message: `This machine has neither ${preferred} nor ${ultimate} installed, so no command string can be run through a shell.`,
  };
}

/**
 * PowerShell 5.1 reports success for a script whose last statement succeeded
 * even when an earlier native command failed:
 *
 *     powershell -Command "cmd /c exit 4; Write-Output after"   # exit 0
 *
 * Measured on this machine; the failure is invisible to the caller, which is
 * the worst shape a failure can have. `$LASTEXITCODE` holds the native exit
 * status and survives a later cmdlet, so the tail reads it first and only falls
 * back to `$?` for a script that never ran a native command. Without the tail
 * the measured exit is 0; with it, 4.
 *
 * The `exit` is what makes the value the process's exit status — PowerShell
 * does not otherwise propagate `$LASTEXITCODE` to its parent.
 */
export const POWERSHELL_EXIT_TAIL =
  "\n; $_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n; exit $_ec";

/**
 * The argument vector that runs `command` under `shell`.
 *
 * The command string is passed as ONE argv element and never re-quoted here.
 * That is the whole reason this works: the shell receives the author's text
 * exactly as written and does its own parsing, so `&&`, a pipe, a redirection
 * and a substitution mean what they mean in that shell. A second quoting layer
 * between the model and the shell would reinterpret them, and every construct
 * that survives it wrong is a bug report instead of a command.
 *
 * `-NoProfile` keeps a user's profile from injecting aliases and prompts into a
 * command the model wrote; `-NonInteractive` stops a script that asks a
 * question from hanging until the timeout. `cmd` gets `/d` for the same reason:
 * AutoRun commands are exactly the state a reproducible run must not inherit.
 */
export function shellExecArgv(shell: DetectedShell, command: string): ReadonlyArray<string> {
  switch (shell.kind) {
    case "bash":
    case "zsh":
    case "sh":
      return [shell.path, "-c", command];
    case "powershell":
      return [shell.path, "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n" + command + POWERSHELL_EXIT_TAIL];
    case "cmd":
      return [shell.path, "/d", "/c", command];
    default:
      // Unreachable through the types, reachable through JavaScript or a config
      // value that was never narrowed — the same reason `resolveShell` re-checks
      // its argument. Falling off a switch here returned `undefined`, and a
      // caller asking for `.length` on that gets a crash instead of a wrong
      // argv. There is no argv to return, so the command is passed alone: the
      // caller's own PATH resolution then fails, which is the answer a machine
      // without that shell can give.
      return [shell.path, command];
  }
}

/**
 * Whether the shell needs Windows' verbatim argument handling.
 *
 * Measured, and the answer is not what the existing `shell` shape assumes:
 *
 *  - `cmd.exe` needs it. With Node's normal quoting, `cmd /c 'echo "a b" && echo c'`
 *    arrives with the quotes escaped (`\"a b\"`) and prints the operators
 *    literally. Verbatim passes the string as written.
 *  - PowerShell and bash must NOT have it. Verbatim on PowerShell splits
 *    `Write-Output "a b"` into two arguments and the shell runs the second as a
 *    command; on bash it produces no output at all **and exits 0**, which is a
 *    command reported as successful that did nothing.
 *
 * So this is a property of the interpreter, not of the platform, and getting it
 * wrong fails silently in the most expensive direction.
 */
export function needsVerbatimArguments(shell: DetectedShell): boolean {
  return shell.kind === "cmd";
}
