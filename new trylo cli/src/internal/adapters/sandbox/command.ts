import { statSync } from "node:fs";
import type { FileAccessMode } from "../../ports/tools.js";
import path from "node:path";
import { resolveInsideWorkspace, type PathDenyCode } from "../tools/shared/workspace.js";
import { isWorkspaceRootCwd } from "./root-cwd-alias.js";

/**
 * Shell command analysis.
 *
 * There is deliberately no shell in the loop: the child process is spawned from
 * an argument vector, so words never reach an interpreter that could re-read
 * them as syntax. That makes this parse the *whole* control surface — anything
 * a shell would have treated as an operator is refused here rather than passed
 * through as a harmless-looking literal argument.
 */

export type ShellParseFailureCode =
  | "empty_command"
  | "shell_parse_failed"
  | "shell_operator_forbidden"
  | "cd_forbidden"
  | "cwd_not_directory"
  | PathDenyCode;

/**
 * The slice of the sandbox policy this module is allowed to read. Keeping it
 * narrow is deliberate: `allowAbsoluteExecutable` is honoured here so that
 * `describePolicy` is not the only thing that knows about it, while the rest of
 * the policy stays out of the parser.
 */
export type ShellCommandPolicy = {
  readonly workspaceRoot: string;
  readonly allowAbsoluteExecutable: boolean;
};

export type ShellToken = {
  readonly text: string;
  /** One flag per character: true when that character came from quoting. */
  readonly quoted: readonly boolean[];
};

export type ShellCommandPlan = {
  readonly ok: true;
  readonly executable: string;
  readonly argv: readonly string[];
};

export type ShellCommandResult =
  | ShellCommandPlan
  | { readonly ok: false; readonly code: ShellParseFailureCode; readonly message: string };

const OPERATORS = "|&;<>()$`";

/**
 * Does this word start out looking like a Windows path?
 *
 * A backslash outside quotes means two different things depending on what
 * surrounds it. `echo a\ b` is POSIX escaping and must keep working: the
 * backslash removes the space's special meaning and the argument is one word.
 * `C:\tools\prog.exe -v` is a path, and treating the backslash as an escape
 * deletes the separators — measured on this machine, that word arrived at the
 * spawner as `C:toolsprog.exe` and failed with an ENOENT naming a program nobody
 * asked for.
 *
 * So the question is not "which platform is this" but "is this word
 * recognisably a path". Two openings qualify, and neither can be confused with
 * an escape because neither contains the escaped character:
 *
 *  - a drive designator: a single letter, a colon, a separator — `C:\`, `d:/`;
 *  - a doubled separator at the start of a word: `\\host\…`, `\\?\C:\…`, `\\.\`.
 *
 * Once a word has opened this way it stays a path: the separators *inside* it
 * (`C:\tools\prog.exe`) have no marker of their own and are only recognisable
 * from the word they belong to. Deciding per backslash instead of per word was
 * tried and measured — it keeps `C:\tools` and then eats `\prog`, which is the
 * original bug with extra steps.
 *
 * Everything else keeps POSIX escaping, which is why this needs no platform flag
 * and why an existing POSIX command cannot change meaning because of it. The
 * whole word is examined here, so both scanners in this file (words and raw
 * text) can ask the same question and cannot drift apart on what a backslash
 * means — the tokenizer, the pipeline splitter, the permission check and the
 * execution plan all inherit one rule.
 */
export function isWindowsPathWord(word: string, following?: string): boolean {
  // A UNC / `\\?\` / `\\.\` opening is a *pair*, so the first backslash cannot be
  // classified from what precedes it — the second one has not been read yet.
  // `following` is the not-yet-consumed text, and it is what makes the pair
  // visible. Without it `\\server\share` loses its first separator and arrives
  // as `\servershare` (measured).
  if (word === "\\" && following?.startsWith("\\") === true) {
    return true;
  }
  if (word.startsWith("\\\\")) {
    return true;
  }
  if (word.length < 3) {
    return false;
  }
  const [first, second, third] = [word[0], word[1], word[2]];
  if (first === undefined || second === undefined || third === undefined) {
    return false;
  }
  // `C:\` or `C:/`
  return second === ":" && /[A-Za-z]/.test(first) && (third === "\\" || third === "/");
}


class CommandScanner {
  private readonly tokens: ShellToken[] = [];
  private pending = { chars: [] as string[], quoted: [] as boolean[] };
  private index = 0;

  constructor(private readonly command: string) {}

  scan(): readonly ShellToken[] | undefined {
    while (this.index < this.command.length) {
      const char = this.command[this.index] ?? "";
      if (char === " " || char === "\t") {
        this.flush();
        this.index += 1;
        continue;
      }
      if (char === "'") {
        if (this.readSingle() === false) {
          return undefined;
        }
        continue;
      }
      if (char === '"') {
        if (this.readDouble() === false) {
          return undefined;
        }
        continue;
      }
      if (char === "\\") {
        if (this.readEscape() === false) {
          return undefined;
        }
        continue;
      }
      this.push(char, false);
      this.index += 1;
    }
    this.flush();
    return this.tokens;
  }

  private readSingle(): boolean {
    const end = this.command.indexOf("'", this.index + 1);
    if (end === -1) {
      return false;
    }
    for (const char of this.command.slice(this.index + 1, end)) {
      this.push(char, true);
    }
    this.index = end + 1;
    return true;
  }

  private readDouble(): boolean {
    let cursor = this.index + 1;
    while (cursor < this.command.length) {
      const char = this.command[cursor] ?? "";
      if (char === '"') {
        this.index = cursor + 1;
        return true;
      }
      if (char === "\\" && ['"', "\\"].includes(this.command[cursor + 1] ?? "")) {
        this.push(this.command[cursor + 1] ?? "", true);
        cursor += 2;
        continue;
      }
      this.push(char, true);
      cursor += 1;
    }
    return false;
  }

  private readEscape(): boolean {
    const next = this.command[this.index + 1];
    if (next === undefined) {
      return false;
    }
    // The word so far, plus this backslash: whether it is a separator depends on
    // the word it belongs to, and a path's later separators carry no marker of
    // their own. The backslash is appended because it is the character that
    // would complete the `C:\` opening — the pending buffer holds `C:` alone —
    // and the rest of the command is passed because a UNC opening is a pair.
    // A path with a space in it has to be quoted, and that is not this rule's
    // business: a space ends the word here exactly as it does on POSIX.
    const word = `${this.pending.chars.join("")}\\`;
    if (isWindowsPathWord(word, this.command.slice(this.index + 1))) {
      this.push("\\", false);
      this.index += 1;
      return true;
    }
    this.push(next, true);
    this.index += 2;
    return true;
  }

  private push(char: string, quoted: boolean): void {
    this.pending.chars.push(char);
    this.pending.quoted.push(quoted);
  }

  private flush(): void {
    if (this.pending.chars.length === 0) {
      return;
    }
    this.tokens.push({ text: this.pending.chars.join(""), quoted: [...this.pending.quoted] });
    this.pending = { chars: [], quoted: [] };
  }
}

/**
 * Splits a command into words honouring quoting and escapes. An unterminated
 * quote or a dangling escape is a hard failure: a partially-read command has no
 * defined meaning, and guessing is how injections get through.
 */
export function tokenizeCommand(command: string): readonly ShellToken[] | undefined {
  return new CommandScanner(command).scan();
}

/** An operator written outside quotes is refused; quoting makes it literal. */
function firstUnquotedOperator(tokens: readonly ShellToken[]): string | undefined {
  for (const token of tokens) {
    for (let index = 0; index < token.text.length; index += 1) {
      const char = token.text[index] ?? "";
      if (OPERATORS.includes(char) && token.quoted[index] !== true) {
        return char;
      }
    }
  }
  return undefined;
}

/**
 * `cd` is refused outright rather than ignored. The child's working directory
 * is the workspace root and stays there; pretending the token meant nothing
 * would change the meaning of the command the user was asked to approve.
 */
function refusesChangeDirectory(executable: string): boolean {
  const base = executable.split(/[\\/]/).pop() ?? executable;
  return base.toLowerCase() === "cd" || base.toLowerCase() === "chdir";
}

/**
 * `cd` is answered with a `cwd` argument instead of a directory change, so the
 * request has to resolve the same way every other workspace path does: inside
 * the root, real, and an existing directory. `..` that climbs out is not a
 * special case to handle — it is a path outside the workspace and is refused.
 */
export function planWorkingDirectory(
  workspaceRoot: string,
  candidate: string,
  access: FileAccessMode = "workspace",
  workspaceAlias?: string,
): { readonly ok: true; readonly absolutePath: string } | { readonly ok: false; readonly code: ShellParseFailureCode; readonly message: string } {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return { ok: false, code: "invalid_path", message: "run_shell cwd must be a non-empty path" };
  }
  const rootAlias = isWorkspaceRootCwd(workspaceRoot, candidate);
  // Absolute workspace subdirectories are aliases, not additional authority.
  // Reject traversal spellings before the shared realpath/link containment gate.
  if (access === "workspace" && candidate.split(/[\\/]/).includes("..")) {
    return { ok: false, code: "path_outside_workspace", message: "run_shell cwd refuses parent traversal" };
  }
  const verdict = resolveInsideWorkspace(workspaceRoot, rootAlias ? "." : candidate, access, workspaceAlias);
  if (!verdict.ok) {
    return {
      ok: false,
      code: verdict.code,
      message: `run_shell cwd refused: ${verdict.code}`,
    };
  }
  try {
    if (!statSync(verdict.absolutePath).isDirectory()) {
      return {
        ok: false,
        code: "cwd_not_directory",
        message: "run_shell cwd must be an existing directory inside the workspace",
      };
    }
  } catch {
    return {
      ok: false,
      code: "cwd_not_directory",
      message: "run_shell cwd must be an existing directory inside the workspace",
    };
  }
  return { ok: true, absolutePath: verdict.absolutePath };
}

/**
 * An executable written with a path separator is resolved against the
 * workspace, so `./scripts/build.sh` means the one in the workspace and not a
 * sibling of the process. The policy is read here rather than only printed:
 * with `allowAbsoluteExecutable` an executable outside the workspace is
 * allowed; by default it is not, and nothing about the default path changes.
 */
function planQualifiedExecutable(policy: ShellCommandPolicy, argv: readonly string[]): ShellCommandResult {
  const [executable, ...rest] = argv;
  if (executable === undefined) {
    return { ok: false, code: "empty_command", message: "run_shell requires a non-empty command" };
  }
  const verdict = resolveInsideWorkspace(policy.workspaceRoot, executable);
  if (!verdict.ok) {
    if (policy.allowAbsoluteExecutable && path.isAbsolute(executable)) {
      const absolute = path.resolve(executable);
      return { ok: true, executable: absolute, argv: [absolute, ...rest] };
    }
    return {
      ok: false,
      code: verdict.code,
      message: `run_shell executable refused: ${verdict.code}`,
    };
  }
  return {
    ok: true,
    executable: verdict.absolutePath,
    argv: [verdict.absolutePath, ...rest],
  };
}

export function planShellCommand(policy: ShellCommandPolicy, command: string): ShellCommandResult {
  if (command.trim().length === 0) {
    return { ok: false, code: "empty_command", message: "run_shell requires a non-empty command" };
  }
  if (/[\r\n]/.test(command)) {
    return {
      ok: false,
      code: "shell_operator_forbidden",
      message:
        "run_shell rejects multi-line commands: it runs one command per call. Write the script into a file with write_file and run that file, or pass the extra commands through 'steps'.",
    };
  }
  const tokens = tokenizeCommand(command);
  if (tokens === undefined) {
    return {
      ok: false,
      code: "shell_parse_failed",
      message: "run_shell could not parse the command",
    };
  }
  if (tokens.length === 0) {
    return { ok: false, code: "empty_command", message: "run_shell requires a non-empty command" };
  }
  const operator = firstUnquotedOperator(tokens);
  if (operator !== undefined) {
    return {
      ok: false,
      code: "shell_operator_forbidden",
      message: `run_shell rejects the shell operator '${operator}' written outside quotes: there is no shell here, so it would reach the program as literal text instead of doing what it does in a shell. Quote the word so it stays one argument ('node -e "console.log(1+(2))"' works), or write the expression into a file with write_file and run that file. For real composition use 'steps' or 'pipeTo'.`,
    };
  }
  const argv = tokens.map((token) => token.text);
  const executable = argv[0] ?? "";
  if (refusesChangeDirectory(executable)) {
    return {
      ok: false,
      code: "cd_forbidden",
      message: "run_shell rejects cd; the working directory is pinned to the workspace",
    };
  }
  if (executable.includes("/") || executable.includes("\\")) {
    return planQualifiedExecutable(policy, argv);
  }
  return { ok: true, executable, argv };
}

export type ShellPipelineSegment = {
  readonly executable: string;
  readonly argv: readonly string[];
};

export type ShellPipelineResult =
  | { readonly ok: true; readonly segments: ReadonlyArray<ShellPipelineSegment> }
  | { readonly ok: false; readonly code: ShellParseFailureCode; readonly message: string };

/**
 * Splits a command on unquoted `|` into pipeline segments.
 *
 * Quote handling mirrors `CommandScanner` (single quotes, double quotes with
 * `\"`/`\\` escapes, backslash escapes): a `|` inside quotes or behind a
 * backslash is literal text, not a pipe. The two scanners share rules rather
 * than code — `splitPipeline` works on raw text so quoting survives the split,
 * while `CommandScanner` works on words — and `adversarial.test.ts` pins their
 * agreement on every tricky shape (`"a|b"`, `'a|b'`, `a\|b`, `a||b`).
 *
 * Only `|` splits. Every other operator stays forbidden, and each segment goes
 * through `planShellCommand`, which refuses those there — so a segment can
 * never smuggle in a redirection, a substitution or a second shell.
 */
function splitPipeline(command: string): { readonly ok: true; readonly segments: string[] } | { readonly ok: false; readonly code: "shell_parse_failed" | "shell_operator_forbidden"; readonly message: string } {
  const segments: string[] = [];
  let current = "";
  const push = (): boolean => {
    if (current.trim().length === 0) {
      return false;
    }
    segments.push(current);
    current = "";
    return true;
  };
  const parseFailed = { ok: false as const, code: "shell_parse_failed" as const, message: "run_shell could not parse the command" };
  let index = 0;
  while (index < command.length) {
    const char = command[index] ?? "";
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) {
        return parseFailed;
      }
      current += command.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      let closed = false;
      let piece = '"';
      while (cursor < command.length) {
        const inner = command[cursor] ?? "";
        if (inner === '"') {
          piece += '"';
          cursor += 1;
          closed = true;
          break;
        }
        if (inner === "\\" && (command[cursor + 1] === '"' || command[cursor + 1] === "\\")) {
          piece += command.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        piece += inner;
        cursor += 1;
      }
      if (!closed) {
        return parseFailed;
      }
      current += piece;
      index = cursor;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        return parseFailed;
      }
      // Same rule and same question as `CommandScanner.readEscape` — is the word
      // this backslash belongs to a path? — so a split can never disagree with
      // the tokenizer about where a word ends. The word is read off `current`
      // rather than `command`, because `current` is the segment so far and a
      // `|` starts a new word; the backslash is appended because it is the
      // character that would complete a `C:\` opening.
      const wordSoFar = current.slice(Math.max(current.lastIndexOf(" "), current.lastIndexOf("\t")) + 1);
      const separator = isWindowsPathWord(`${wordSoFar}\\`, command.slice(index + 1));
      current += separator ? "\\" : command.slice(index, index + 2);
      index += separator ? 1 : 2;
      continue;
    }
    if (char === "|") {
      if (!push()) {
        return {
          ok: false,
          code: "shell_parse_failed",
          message: "run_shell refuses an empty pipeline segment: a pipe needs a command on both sides, and `||` is not two pipes",
        };
      }
      index += 1;
      continue;
    }
    if (char === ">" || char === "<") {
      return {
        ok: false,
        code: "shell_operator_forbidden",
        message: `run_shell redirection ('${char}') is not supported: commands run as programs and arguments, with no shell interpreter. This also applies to workspace files. Use write_file/edit_file for file changes, or the supported pipeline/steps options for command composition; approval does not enable shell syntax.`,
      };
    }
    current += char;
    index += 1;
  }
  if (!push()) {
    return {
      ok: false,
      code: "shell_parse_failed",
      message: "run_shell refuses an empty pipeline segment: a pipe needs a command on both sides",
    };
  }
  return { ok: true, segments };
}

/**
 * One command, possibly piped. A single segment behaves byte-for-byte like
 * `planShellCommand`; several segments are each planned by it, so the refusal
 * rules apply per segment and the pipeline is only as admissible as its
 * least admissible half.
 */
export function planShellPipeline(
  policy: ShellCommandPolicy,
  command: string,
): ShellPipelineResult {
  if (command.trim().length === 0) {
    return { ok: false, code: "empty_command", message: "run_shell requires a non-empty command" };
  }
  if (/[\r\n]/.test(command)) {
    return {
      ok: false,
      code: "shell_operator_forbidden",
      message:
        "run_shell rejects multi-line commands: it runs one command per call. Write the script into a file with write_file and run that file, or pass the extra commands through 'steps'.",
    };
  }
  const split = splitPipeline(command);
  if (!split.ok) {
    return split;
  }
  const segments: ShellPipelineSegment[] = [];
  for (const text of split.segments) {
    const planned = planShellCommand(policy, text);
    if (!planned.ok) {
      return planned;
    }
    segments.push({ executable: planned.executable, argv: planned.argv });
  }
  return { ok: true, segments };
}
