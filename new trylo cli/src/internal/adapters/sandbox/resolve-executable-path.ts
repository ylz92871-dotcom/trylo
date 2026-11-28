import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { hostProcessEnvironment, hostShellEnvironment, isExecutableFile } from "./executable.js";

/**
 * Turning a program name into the file that will actually be started.
 *
 * # Why this exists
 *
 * The PTY sidecar is a separate process with its own idea of what `PATH` means:
 * `portable-pty` builds its Windows `CreateProcessW` call from the environment it
 * was handed, and once that environment is cleared the sidecar's own search has
 * nothing to search with. A bare `node` that starts fine under `child_process`
 * would fail there — and it would fail *differently* from how it fails, which is
 * the dangerous part.
 *
 * So the CLI resolves the program before handing it over, and the sidecar is
 * told an absolute path. That is not a second search policy: the rules below
 * come from the same `PATH`/`PATHEXT` the rest of the CLI uses, and
 * `lookupExecutable` in `executable.ts` remains the authority on *what kind* of
 * program a name refers to. This module only answers *which file*.
 *
 * The alternative — letting the sidecar search — was rejected because it makes
 * two answers to "what runs" where only one has been through the sandbox's
 * rules, and the one that has not is the one that actually starts a process.
 */

export type ResolvedExecutable =
  | {
      readonly ok: true;
      /** Absolute path to the program. Never a bare name. */
      readonly absolutePath: string;
      /** True for `.cmd`/`.bat`, which need a command interpreter, not `CreateProcess`. */
      readonly needsShell: boolean;
    }
  | {
      readonly ok: false;
      readonly code: "executable_not_found" | "executable_not_a_file";
      readonly message: string;
    };

/**
 * Windows decides what is runnable by extension, so the search has to try them.
 *
 * Read through `executable.ts`, which is this layer's sanctioned environment
 * reader. Reaching for `process.env` here instead would be a second invisible
 * reader in a file the gate does not trust with one — and the two would drift,
 * which is how a program resolves on one code path and not the other.
 */
const DEFAULT_PATH_EXTENSIONS: readonly string[] = [".COM", ".EXE", ".BAT", ".CMD"];

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

function pathExtensions(): readonly string[] {
  const raw = hostProcessEnvironment()["PATHEXT"];
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
  const raw = hostProcessEnvironment()["PATH"];
  if (typeof raw !== "string") {
    return [];
  }
  return raw.split(path.delimiter).filter((entry) => entry.length > 0);
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `executable` to the file that will be started.
 *
 * A name that already looks like a path is checked as given and not searched
 * for, because a caller who wrote `C:\tools\x.exe` has already chosen the file
 * and a `PATH` hit would quietly override that choice. A bare name is searched
 * in `PATH` order with `PATHEXT` order inside each directory, which is what the
 * platform itself does — the order is the platform's, not this module's.
 *
 * `undefined` in, `executable_not_found` out: a program that cannot be found is
 * not this function's decision to make, but the sidecar's error for it would be
 * about its own environment, which is a different and less useful fact.
 */
export function resolveExecutablePath(executable: string, cwd?: string): ResolvedExecutable {
  if (executable.length === 0) {
    return {
      ok: false,
      code: "executable_not_found",
      message: "no program was named",
    };
  }

  const windows = hostShellEnvironment().platform === "win32";
  const hasDirectoryPart = executable.includes("/") || (windows && executable.includes("\\"));
  if (hasDirectoryPart || path.isAbsolute(executable)) {
    const absolute = cwd === undefined ? path.resolve(executable) : path.resolve(cwd, executable);
    if (!existsSync(absolute)) {
      return {
        ok: false,
        code: "executable_not_found",
        message: `${executable} does not exist`,
      };
    }

    if (!isRegularFile(absolute)) {
      return {
        ok: false,
        code: "executable_not_a_file",
        message: `${executable} is not a regular file, so it cannot be started`,
      };
    }

    if (!windows && !isExecutableFile(absolute)) {
      return { ok: false, code: "executable_not_a_file", message: `${executable} is not executable` };
    }

    const extension = path.extname(absolute).toLowerCase();

    return {
      ok: true,
      absolutePath: absolute,
      needsShell: windows && SCRIPT_EXTENSIONS.has(extension),
    };
  }

  const extension = path.extname(executable).toLowerCase();
  // A name that already carries an extension is not given another one. Adding
  // `.EXE` to `tool.exe` would search for a program nobody asked for.
  const candidates: readonly string[] =
    !windows || extension.length > 0 ? [executable] : [executable, ...pathExtensions().map((ext) => executable + ext)];

  for (const directory of searchPath()) {
    for (const candidate of candidates) {
      const full = cwd === undefined ? path.resolve(directory, candidate) : path.resolve(cwd, directory, candidate);
      if (!(windows ? isRegularFile(full) : isExecutableFile(full))) {
        continue;
      }

      const candidateExtension = path.extname(full).toLowerCase();

      return {
        ok: true,
        absolutePath: full,
        needsShell: windows && SCRIPT_EXTENSIONS.has(candidateExtension),
      };
    }
  }

  return {
    ok: false,
    code: "executable_not_found",
    message: `${executable} is not on PATH and was not found as a path`,
  };
}
