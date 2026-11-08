/**
 * Git command surface for managed worktrees (WP25.2 / C79, L70).
 *
 * Source: Codex `codex-rs/worktree/src/git.rs` — the whole file, and
 * `codex-rs/worktree/src/lib.rs:76-139` for the command sequence.
 *
 * Why this is stricter than the read-only git hardening in
 * `surface/cli/git-diff.ts`, which the same repo already has: a diff only
 * *reads* the working tree, while `worktree add` creates one and materialises
 * files into it. Repository-controlled machinery therefore has to be off in
 * more places — attribute lookup (`attr.tree`, `core.attributesFile`) joins
 * hooks and fsmonitor, and the *smudge* filter joins clean/process because
 * checkout is the one operation that runs it. The two are kept apart on
 * purpose; this module states the delta rather than quietly sharing a base.
 *
 * The environment scrub is not hygiene, it is correctness: `git` picks up its
 * repository, index and object directory from ambient variables, so a checkout
 * created from inside a hook or a wrapper would silently bind to the wrong
 * repository. Every selector is dropped and every command re-derives the
 * repository from the working directory it is given.
 *
 * Pure: no process, no clock, no filesystem, no read of `process.env`. The
 * environment arrives as an argument from the caller's injection seam.
 */

import type { WorktreePlatform } from "./worktree-layout.js";

/** Codex `git.rs:101-120`, in order. */
export const WORKTREE_GIT_ENV_UNSET: ReadonlyArray<string> = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** Codex `git.rs:133-134`: never prompt, never fetch LFS content on checkout. */
export const WORKTREE_GIT_ENV_SET: Readonly<Record<string, string>> = {
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Same value as `surface/cli/git-diff.ts::nullDevice`; domain does not import
 * `surface`, so the platform table is stated here instead of shared.
 */
const HOOKS_PATH: Readonly<Record<WorktreePlatform, string>> = {
  win32: "NUL",
  posix: "/dev/null",
};

/**
 * Drops inherited selectors, then pins our own. Returning a new record rather
 * than mutating keeps the caller's environment intact for other commands.
 */
export function scrubGitEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string | undefined>> {
  const next: Record<string, string | undefined> = { ...(env ?? {}) };
  for (const name of WORKTREE_GIT_ENV_UNSET) {
    delete next[name];
  }
  return { ...next, ...WORKTREE_GIT_ENV_SET };
}

/** Codex `git.rs:121-134`. `-c` overrides are command-local, never persisted. */
export function worktreeGitArgv(
  platform: WorktreePlatform,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    "git",
    "-c",
    "safe.bareRepository=explicit",
    "-c",
    `core.hooksPath=${HOOKS_PATH[platform]}`,
    "-c",
    "core.fsmonitor=",
    "-c",
    "attr.tree=",
    "-c",
    "core.attributesFile=",
    ...args,
  ];
}

/** Codex `lib.rs:76-84`: `<base>^{commit}` peels tags down to a commit. */
export function resolveCommitArgv(platform: WorktreePlatform, base: string): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
}

/** Codex `lib.rs:87-98`: detached, and empty until we populate it ourselves. */
export function worktreeAddArgv(platform: WorktreePlatform, root: string, sha: string): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["worktree", "add", "--detach", "--no-checkout", root, sha]);
}

/** Codex `lib.rs:106-114`: where the *destination's* config lives. */
export function worktreeConfigPathArgv(platform: WorktreePlatform): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"]);
}

/** Codex `lib.rs:116-126`: pin the destination even when per-worktree config is off. */
export function setCoreWorktreeArgv(platform: WorktreePlatform, configPath: string, root: string): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["config", "--file", configPath, "core.worktree", root]);
}

/** Codex `lib.rs:129-139`. */
export function populateWorktreeArgv(platform: WorktreePlatform, sha: string): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["--work-tree=.", "reset", "--hard", "--no-recurse-submodules", sha]);
}

/** Codex `lib.rs:177-181`. */
export function worktreeListArgv(platform: WorktreePlatform): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["worktree", "list", "--porcelain", "-z"]);
}

/** Codex `lib.rs:303-313`: untracked-but-ignored files, the ones `remove` refuses over. */
export function ignoredFilesArgv(platform: WorktreePlatform): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
}

/** Codex `lib.rs:317-325` (no force) and `:349-358` (rollback only). */
export function worktreeRemoveArgv(platform: WorktreePlatform, root: string, force: boolean): ReadonlyArray<string> {
  return worktreeGitArgv(platform, force ? ["worktree", "remove", "--force", root] : ["worktree", "remove", root]);
}

/**
 * Codex `lib.rs:399-406` and `metadata.rs:89`: every `rev-parse` query in the
 * port goes through here, including `--show-toplevel`, `--git-dir`,
 * `--git-common-dir` and `--git-path <name>`.
 */
export function revParseArgv(platform: WorktreePlatform, args: ReadonlyArray<string>): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["rev-parse", ...args]);
}

/** Codex `git.rs:139-171`. */
export function filterProbeArgv(platform: WorktreePlatform): ReadonlyArray<string> {
  return worktreeGitArgv(platform, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."]);
}

/**
 * Codex `git.rs:139-171` keeps `clean`, `smudge`, `process`, `required`; the
 * diff hardener in this repo keeps only `clean` and `process` because a read
 * never runs a smudge filter. Same idea, deliberately different set.
 */
const FILTER_ATTRIBUTES: ReadonlyArray<string> = ["clean", "smudge", "process", "required"];

/** NUL-separated `filter.<driver>.<attribute>` keys to bare driver names. */
export function parseFilterDriverNames(output: string): ReadonlyArray<string> {
  const drivers = new Set<string>();

  for (const key of output.split("\0")) {
    const dot = key.lastIndexOf(".");
    if (dot <= "filter.".length - 1 || !key.startsWith("filter.")) {
      continue;
    }

    const driver = key.slice("filter.".length, dot);
    const attribute = key.slice(dot + 1);
    if (driver.length > 0 && FILTER_ATTRIBUTES.includes(attribute)) {
      drivers.add(driver);
    }
  }

  return [...drivers].sort();
}

/**
 * Neuters each driver through `GIT_CONFIG_COUNT`, the way Codex
 * `git.rs:42-51` does, so a repository cannot select an executable helper for
 * a command we are running on the user's behalf. Empty value means "unset it",
 * and `required=false` stops git treating the now-missing helper as fatal.
 */
export function filterNeuterEnv(drivers: ReadonlyArray<string>): Readonly<Record<string, string>> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(drivers.length * FILTER_ATTRIBUTES.length) };

  drivers.forEach((driver, driverIndex) => {
    FILTER_ATTRIBUTES.forEach((attribute, attributeIndex) => {
      const index = driverIndex * FILTER_ATTRIBUTES.length + attributeIndex;
      env[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`;
      env[`GIT_CONFIG_VALUE_${index}`] = attribute === "required" ? "false" : "";
    });
  });

  return env;
}

export type WorktreeListEntry = {
  readonly root: string;
  readonly headSha: string | undefined;
  readonly branch: string | undefined;
};

/**
 * Parses `worktree list --porcelain -z`. Codex `lib.rs:182-205`: fields are
 * NUL-separated and entries are separated by an empty field, which is the only
 * reason an entry boundary can be told from a path containing a newline.
 */
export function parseWorktreeList(output: string): ReadonlyArray<WorktreeListEntry> {
  const fields = output.split("\0");
  const entries: WorktreeListEntry[] = [];
  let root: string | undefined;
  let headSha: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (root !== undefined) {
      entries.push({ root, headSha, branch });
    }
    root = undefined;
    headSha = undefined;
    branch = undefined;
  };

  for (const field of fields) {
    if (field.length === 0) {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      root = field.slice("worktree ".length);
    } else if (field.startsWith("HEAD ")) {
      headSha = field.slice("HEAD ".length);
    } else if (field.startsWith("branch ")) {
      const name = field.slice("branch ".length);
      branch = name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
    }
  }

  flush();

  return entries;
}
