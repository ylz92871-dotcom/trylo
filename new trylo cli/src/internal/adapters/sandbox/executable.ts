import { existsSync } from "node:fs";
import path from "node:path";
import type { ShellEnvironment } from "./shell-detect.js";

/**
 * Turning an argument vector into something this platform can actually run.
 *
 * The loop hands over an argv, never a command string, and that is what keeps
 * words from being re-read as syntax. Windows breaks the property for one
 * class of program: `npm`, `tsc` and most of a JS toolchain are `.cmd` batch
 * scripts, which `CreateProcess` cannot start. The usual fix is `shell: true`,
 * which hands the whole line to cmd and therefore hands back every operator
 * this package refuses.
 *
 * So the fix stays structural: when — and only when — the resolved program is
 * a batch script, cmd is invoked through a *controlled* form in which every
 * word is quoted by this module before cmd ever sees it. cmd is still there,
 * but it is given nothing to interpret.
 */

export type CommandShape =
  | { readonly kind: "direct"; readonly argv: readonly string[] }
  | { readonly kind: "shell"; readonly argv: readonly string[] };

export type CommandShapeDenyCode =
  | "empty_command"
  | "cmd_metacharacter_forbidden"
  | "command_shell_unavailable";

export type CommandShapeResult =
  | { readonly ok: true; readonly shape: CommandShape }
  | { readonly ok: false; readonly code: CommandShapeDenyCode; readonly message: string };

/** Extensions that are batch scripts rather than executables. */
const SCRIPT_EXTENSIONS = [".cmd", ".bat"];

const DEFAULT_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * The environment a child process inherits.
 *
 * This file is already the sandbox layer's sanctioned reader of the process
 * environment — it has to be, to resolve `PATH` and `PATHEXT` — and it is on the
 * gate's allowlist for exactly that reason. Exposing the read here is what lets
 * a sibling module spawn a child with the host environment **without** growing a
 * second, invisible reader of `process.env` in a file the gate (rightly) does not
 * trust with one.
 *
 * The returned object is a copy: a caller that mutates it is editing its own
 * child's environment, not the host's.
 */
export function hostProcessEnvironment(): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Windows keeps one casing per name on enumeration: a process that holds
  // both `PATH` and `Path` spreads only one of them, and a child that reads
  // the other spelling (MSYS bash reads exactly `PATH`) finds nothing and
  // presents as a broken install. Both spellings name the same directory
  // list, so the copy carries both — reading stays case-insensitive, and no
  // caller has to know which spelling the parent happened to keep.
  const pathKey = process.platform === "win32"
    ? Object.keys(env).find(name => name.toLowerCase() === "path") : undefined;
  const executablePath = env["PATH"] ?? env["Path"] ?? (pathKey === undefined ? undefined : env[pathKey]);
  if (executablePath !== undefined) {
    env["PATH"] ??= executablePath;
    env["Path"] ??= executablePath;
  }
  return env;
}

/** The installed CLI's Node executable, never a model-selected bridge runtime. */
export function hostNodeExecutable(): string { return process.execPath; }

function pathExtensions(): readonly string[] {
  const raw = process.env["PATHEXT"];
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_PATH_EXTENSIONS;
  }
  const parsed = raw
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("."));
  return parsed.length === 0 ? DEFAULT_PATH_EXTENSIONS : parsed;
}

function searchPath(): readonly string[] {
  const raw = process.env["PATH"];
  if (typeof raw !== "string") {
    return [];
  }
  return raw.split(path.delimiter).filter((entry) => entry.length > 0);
}

export type ExecutableLookup =
  | { readonly kind: "binary" }
  | { readonly kind: "script"; readonly target: string };

function executableOnPath(name: string, extensions: readonly string[]): string | undefined {
  for (const directory of searchPath()) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * What the platform would treat this program as. `.cmd`/`.bat` need cmd;
 * anything else goes to `CreateProcess` exactly as it does today. A program
 * that cannot be found is reported as a binary: not finding it is not this
 * module's decision to make, and the spawn will say so.
 */
export function lookupExecutable(executable: string): ExecutableLookup {
  if (process.platform !== "win32") {
    return { kind: "binary" };
  }
  const extension = path.extname(executable).toLowerCase();
  if (SCRIPT_EXTENSIONS.includes(extension)) {
    // A quoted bare batch can receive the caller's cwd as its %~dp0. Pin its
    // actual PATH target, just as the extensionless lookup already does.
    const target = path.basename(executable) === executable ? executableOnPath(executable, [""]) : undefined;
    return { kind: "script", target: target ?? executable };
  }
  if (extension.length > 0) {
    return { kind: "binary" };
  }
  const candidate = executableOnPath(executable, pathExtensions());
  if (candidate !== undefined && SCRIPT_EXTENSIONS.includes(path.extname(candidate).toLowerCase())) {
    return { kind: "script", target: candidate };
  }
  return { kind: "binary" };
}

/**
 * One word, quoted so that cmd cannot reinterpret it.
 *
 * Every word is quoted rather than only the awkward ones, because cmd's rule
 * for `^` differs inside and outside quotes and guessing wrong either eats the
 * character (`npm i pkg@^1.2.0` silently becomes `pkg@1.2.0`) or lets it act
 * as an escape. Measured on this machine: inside quotes `^` and `&` arrive
 * literally, so `^` needs no refusal.
 *
 * Backslashes are doubled only where they would otherwise escape the closing
 * quote, which is the one place MSVCRT's unquoting can be misled.
 */
export function quoteForCommandShell(word: string): string {
  let out = '"';
  let index = 0;
  while (index < word.length) {
    const char = word[index] ?? "";
    if (char === "\\") {
      let run = 0;
      while (word[index] === "\\") {
        run += 1;
        index += 1;
      }
      const next = word[index];
      out += "\\".repeat(next === '"' || next === undefined ? run * 2 : run);
      continue;
    }
    if (char === '"') {
      out += '\\"';
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return `${out}"`;
}

/**
 * The whole line handed to cmd. The extra outer pair is what `/s` strips, so
 * the per-word quoting underneath survives intact — without it cmd removes the
 * first and last quote of the line and the words collapse into one token.
 */
export function buildCommandShellLine(argv: readonly string[]): string {
  return `"${argv.map((word) => quoteForCommandShell(word)).join(" ")}"`;
}

export function commandShellPath(): string | undefined {
  const value = process.env["ComSpec"] ?? process.env["COMSPEC"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Percent expansion is the one thing quoting does not stop: cmd expands
 * `%NAME%` even inside a quoted word, and there is no reliable escape for it on
 * a command line. Refusing it is the honest answer — safer than shipping an
 * escaping rule that only looks right.
 */
const UNQUOTABLE = /%/;
const CONTROL = /[\r\n]/;

function refusesShellWord(word: string): boolean {
  return UNQUOTABLE.test(word) || CONTROL.test(word);
}

export function shapeCommand(argv: readonly string[]): CommandShapeResult {
  const [executable, ...rest] = argv;
  if (executable === undefined) {
    return { ok: false, code: "empty_command", message: "run_shell requires a non-empty command" };
  }
  const lookup = lookupExecutable(executable);
  if (lookup.kind === "binary") {
    return { ok: true, shape: { kind: "direct", argv } };
  }
  const shell = commandShellPath();
  if (shell === undefined) {
    return {
      ok: false,
      code: "command_shell_unavailable",
      message:
        "run_shell cannot start a Windows batch script: ComSpec is unset. Set ComSpec to cmd.exe, or call the underlying executable directly.",
    };
  }
  const words = [lookup.target, ...rest];
  const offender = words.find((word) => refusesShellWord(word));
  if (offender !== undefined) {
    return {
      ok: false,
      code: "cmd_metacharacter_forbidden",
      message:
        "run_shell refuses '%%' and line breaks in a command that must go through cmd; they are expanded rather than passed through",
    };
  }
  return {
    ok: true,
    shape: { kind: "shell", argv: [shell, "/d", "/s", "/c", buildCommandShellLine(words)] },
  };
}

/**
 * The host record `shell-detect.ts` reads.
 *
 * This file is the layer's owner of the platform: it is on the gate's ambient
 * allowlist for reading `PATH`/`PATHEXT`/`ComSpec`, and shell detection needs
 * the same two facts plus a filesystem probe. Building the record here rather
 * than in `shell-detect.ts` is what keeps that module a pure function of its
 * input — the detection rules can then be asserted against a machine that is
 * not this one (`"no PowerShell installed"` is a fact about a `PATH` array, not
 * about the test host), and no second file needs an ambient exemption.
 *
 * Overrides exist so a caller with a real `CliContext` can pass the values it
 * already holds instead of re-reading the process a second time.
 */
export function hostShellEnvironment(
  overrides: Partial<ShellEnvironment> = {},
): ShellEnvironment {
  return {
    platform: overrides.platform ?? process.platform,
    env: overrides.env ?? process.env,
    fileExists: overrides.fileExists ?? existsSync,
  };
}
