/**
 * Read-only workspace diff, including untracked files (WP11.1, C21).
 *
 * Command-shape port of Codex `tui/src/get_git_diff.rs`: the same `rev-parse`
 * repo probe, the same tracked `diff` flags, the same `ls-files --others`
 * untracked discovery with one `--no-index` diff per file, and the same
 * hardening — hooks disabled, `safe.bareRepository=explicit`, fsmonitor off,
 * and configured `filter.*.clean|process` drivers neutered through
 * `GIT_CONFIG_COUNT/KEY_/VALUE_` env. One deliberate delta, recorded rather
 * than hidden: fsmonitor is always disabled here instead of probed-then-
 * reused. The probe only chooses the faster path; disabling is always
 * correct, and a TS port has no shared probe cache to reuse it through.
 * Colour is a caller option (default off) instead of always on, because this
 * module also feeds `--json` and pipes, where escape codes would be data
 * corruption; Codex always colours only because its consumer is the TUI.
 *
 * Pure except for the injected runner: no `process`, no clock, no reads of
 * its own. Git not being installed and the user cancelling are typed
 * failures, not exceptions past the boundary.
 */

export const GIT_DIFF_TIMEOUT_MS = 30_000;

export const SAFE_BARE_REPOSITORY_CONFIG = "safe.bareRepository=explicit";

export type GitDiffPlatform = "win32" | "posix";

export type GitCommandResult = {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type GitCommandRunner = {
  run(
    argv: ReadonlyArray<string>,
    cwd: string,
    options?: { readonly signal?: AbortSignal; readonly env?: Readonly<Record<string, string | undefined>> },
  ): Promise<GitCommandResult>;
};

export type GitDiffInput = {
  readonly cwd: string;
  readonly platform: GitDiffPlatform;
  readonly color?: boolean;
  readonly signal?: AbortSignal;
  /**
   * Base environment for the child, from the injected CLI context. Absent
   * means plain inheritance. Driver neutering merges over it; neither layer
   * reads the process environment here.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
};

export type GitDiffSuccess = {
  /** False outside a work tree: informational, with an empty diff. */
  readonly isGitRepo: boolean;
  readonly diff: string;
};

export type GitDiffFailureCode = "git_unavailable" | "diff_failed" | "cancelled";

export type GitDiffFailure = {
  readonly ok: false;
  readonly code: GitDiffFailureCode;
  readonly detail: string;
};

export type GitDiffOutcome = { readonly ok: true; readonly value: GitDiffSuccess } | GitDiffFailure;

export function nullDevice(platform: GitDiffPlatform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

function hooksOff(platform: GitDiffPlatform): string {
  return platform === "win32" ? "core.hooksPath=NUL" : "core.hooksPath=/dev/null";
}

function baseArgv(platform: GitDiffPlatform): ReadonlyArray<string> {
  return ["git", "-c", SAFE_BARE_REPOSITORY_CONFIG, "-c", "core.fsmonitor=false", "-c", hooksOff(platform)];
}

function colorFlag(color: boolean): string {
  return color ? "--color" : "--no-color";
}

/** `git rev-parse --is-inside-work-tree`: inspects nothing, safe to probe first. */
export function revParseArgv(platform: GitDiffPlatform): ReadonlyArray<string> {
  return [...baseArgv(platform), "rev-parse", "--is-inside-work-tree"];
}

/** Lists configured executable filter drivers, NUL-separated, exit 1 when none. */
export function filterDriversArgv(platform: GitDiffPlatform): ReadonlyArray<string> {
  return [...baseArgv(platform), "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"];
}

/** Tracked changes. Exit 1 means "differences present", not failure. */
export function trackedDiffArgv(platform: GitDiffPlatform, color: boolean): ReadonlyArray<string> {
  return [
    ...baseArgv(platform),
    "diff",
    "--no-textconv",
    "--no-ext-diff",
    "--submodule=short",
    "--ignore-submodules=dirty",
    colorFlag(color),
  ];
}

/** Untracked paths, one per line. */
export function untrackedListArgv(platform: GitDiffPlatform): ReadonlyArray<string> {
  return [...baseArgv(platform), "ls-files", "--others", "--exclude-standard"];
}

/** Merge-base of HEAD and a branch, for base-branch reviews. Exit 0 carries the sha. */
export function mergeBaseArgv(platform: GitDiffPlatform, branch: string): ReadonlyArray<string> {
  return [...baseArgv(platform), "merge-base", "HEAD", branch];
}

/** One untracked file diffed against the null device. Exit 1 means differences. */
export function untrackedDiffArgv(
  platform: GitDiffPlatform,
  color: boolean,
  file: string,
): ReadonlyArray<string> {
  return [
    ...baseArgv(platform),
    "diff",
    "--no-textconv",
    "--no-ext-diff",
    "--submodule=short",
    "--ignore-submodules=dirty",
    colorFlag(color),
    "--no-index",
    "--",
    nullDevice(platform),
    file,
  ];
}

/** NUL-separated `filter.<driver>.clean|process` keys to bare driver names. */
export function parseDriverNames(output: string): ReadonlyArray<string> {
  const drivers = new Set<string>();

  for (const key of output.split("\0")) {
    const base = key.endsWith(".clean")
      ? key.slice(0, -".clean".length)
      : key.endsWith(".process")
        ? key.slice(0, -".process".length)
        : undefined;
    if (base !== undefined && base.length > 0) {
      drivers.add(base);
    }
  }

  return [...drivers].sort();
}

/**
 * Driver neutering as env, the way `run_git_command` carries it: each driver
 * contributes `clean` (empty), `process` (empty) and `required=false`, so
 * repository configuration cannot select executable diff helpers for an
 * informational command.
 */
export function driverNeuterEnv(drivers: ReadonlyArray<string>): Readonly<Record<string, string>> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(drivers.length * 3) };

  drivers.forEach((driver, index) => {
    env[`GIT_CONFIG_KEY_${index * 3}`] = `${driver}.clean`;
    env[`GIT_CONFIG_VALUE_${index * 3}`] = "";
    env[`GIT_CONFIG_KEY_${index * 3 + 1}`] = `${driver}.process`;
    env[`GIT_CONFIG_VALUE_${index * 3 + 1}`] = "";
    env[`GIT_CONFIG_KEY_${index * 3 + 2}`] = `${driver}.required`;
    env[`GIT_CONFIG_VALUE_${index * 3 + 2}`] = "false";
  });

  return env;
}

function fail(code: GitDiffFailureCode, detail: string): GitDiffOutcome {
  return { ok: false, code, detail };
}

function describe(argv: ReadonlyArray<string>, exit: number): string {
  return `git ${argv.slice(1).join(" ")} failed with status ${exit}`;
}

type RunStep =
  | { readonly ok: true; readonly result: GitCommandResult }
  | { readonly ok: false; readonly outcome: GitDiffOutcome };

/**
 * Runs one git command. Spawn failures (git missing, cwd unreadable) become
 * `git_unavailable`; an aborted signal becomes `cancelled`. Callers decide
 * which exits are data (0, and 1 for diffs) versus failure.
 */
async function runGit(
  runner: GitCommandRunner,
  argv: ReadonlyArray<string>,
  cwd: string,
  input: GitDiffInput,
  neuter?: Readonly<Record<string, string>>,
): Promise<RunStep> {
  if (input.signal?.aborted === true) {
    return { ok: false, outcome: fail("cancelled", "the diff was cancelled before git ran") };
  }

  const env = envOf(input.baseEnv, neuter);

  try {
    const options = {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(env === undefined ? {} : { env }),
    };
    const result = await runner.run(argv, cwd, options);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, outcome: fail("git_unavailable", error instanceof Error ? error.message : String(error)) };
  }
}

function envOf(
  base: Readonly<Record<string, string | undefined>> | undefined,
  neuter: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string | undefined>> | undefined {
  if (base === undefined && neuter === undefined) {
    return undefined;
  }

  const merged: Record<string, string | undefined> = {};

  if (base !== undefined) {
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }

  if (neuter !== undefined) {
    for (const [key, value] of Object.entries(neuter)) {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Collects the workspace diff. Outside a git repository this succeeds with
 * `isGitRepo: false` and an empty diff — the caller says "not a git
 * repository" instead of failing, exactly like Codex `/diff`.
 */
export async function collectGitDiff(
  runner: GitCommandRunner,
  input: GitDiffInput,
): Promise<GitDiffOutcome> {
  const color = input.color === true;
  const probe = await runGit(runner, revParseArgv(input.platform), input.cwd, input);
  if (!probe.ok) {
    return probe.outcome;
  }

  if (probe.result.exit !== 0) {
    return { ok: true, value: { isGitRepo: false, diff: "" } };
  }

  const drivers = await runGit(runner, filterDriversArgv(input.platform), input.cwd, input);
  if (!drivers.ok) {
    return drivers.outcome;
  }

  if (drivers.result.exit !== 0 && drivers.result.exit !== 1) {
    return fail("diff_failed", describe(filterDriversArgv(input.platform), drivers.result.exit));
  }

  const env = driverNeuterEnv(parseDriverNames(drivers.result.stdout));
  const tracked = await runGit(runner, trackedDiffArgv(input.platform, color), input.cwd, input, env);
  if (!tracked.ok) {
    return tracked.outcome;
  }

  if (tracked.result.exit !== 0 && tracked.result.exit !== 1) {
    return fail("diff_failed", describe(trackedDiffArgv(input.platform, color), tracked.result.exit));
  }

  const listed = await runGit(runner, untrackedListArgv(input.platform), input.cwd, input, env);
  if (!listed.ok) {
    return listed.outcome;
  }

  if (listed.result.exit !== 0) {
    return fail("diff_failed", describe(untrackedListArgv(input.platform), listed.result.exit));
  }

  let untracked = "";
  const files = listed.result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

  for (const file of files) {
    const argv = untrackedDiffArgv(input.platform, color, file);
    const rendered = await runGit(runner, argv, input.cwd, input, env);
    if (!rendered.ok) {
      return rendered.outcome;
    }

    if (rendered.result.exit !== 0 && rendered.result.exit !== 1) {
      return fail("diff_failed", describe(argv, rendered.result.exit));
    }

    untracked += rendered.result.stdout;
  }

  return { ok: true, value: { isGitRepo: true, diff: `${tracked.result.stdout}${untracked}` } };
}
