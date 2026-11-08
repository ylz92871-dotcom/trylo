import nodePath from "node:path";
import {
  filterNeuterEnv,
  filterProbeArgv,
  parseFilterDriverNames,
  revParseArgv,
  scrubGitEnv,
} from "../../domain/worktree-command.js";
import { isWithin, type WorktreePlatform } from "../../domain/worktree-layout.js";
import type { WorktreeFailure, WorktreeSettings } from "../../ports/worktree.js";
import type { GitCommandRunner } from "../../surface/cli/git-diff.js";
import type { WorktreeIo } from "./worktree-io.js";

/**
 * Shared mechanics behind the worktree port (WP25.2 / C79, L70).
 *
 * Source: Codex `codex-rs/worktree/src/git.rs:35-78` for the run/decode pair
 * and `codex-rs/worktree/src/lib.rs:363-410` for the repository probes.
 *
 * `metadata` versus `working-tree` is not a nicety. Codex neuters configured
 * filter drivers only for operations that materialise files, because those are
 * the ones that would otherwise execute a repository-supplied helper. A
 * `rev-parse` never reads a blob, so paying for a probe there is pure
 * overhead — and, worse, makes the two operation classes look interchangeable
 * when they are not.
 *
 * Failure is always a value. `git_unavailable` means nothing ran, which a
 * caller must never read as git's verdict; `git_failed` carries git's words.
 */

/** Codex `git.rs:29-33`. Which hardening a command needs is part of every call. */
export type WorktreeGitOperation = "metadata" | "working-tree";

export type WorktreeContext = {
  readonly settings: WorktreeSettings;
  readonly runner: GitCommandRunner;
  readonly io: WorktreeIo;
  /** Returns at least four hex characters; a bucket takes the first four. */
  readonly randomHex: () => string;
};

export type WorktreeEnvRequest = {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
};

export type GitStep =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly failure: WorktreeFailure };

export type TextStep = string | WorktreeFailure;

export function platformOf(context: WorktreeContext): WorktreePlatform {
  return context.settings.platform;
}

export function joinUnder(context: WorktreeContext, base: string, child: string): string {
  return context.settings.platform === "win32" ? nodePath.win32.join(base, child) : nodePath.posix.join(base, child);
}

export function parentOf(context: WorktreeContext, path: string): string {
  return context.settings.platform === "win32" ? nodePath.win32.dirname(path) : nodePath.posix.dirname(path);
}

/**
 * Resolves `child` against `base`, but an absolute `child` replaces `base`
 * outright — `std::path::Path::join` semantics. `node:path`'s `join` does the
 * opposite and would produce `<base>/<absolute child>`, which is exactly how a
 * backlink file (`gitdir: /abs/path`) silently fails to match its checkout.
 */
export function resolveAgainst(context: WorktreeContext, base: string, child: string): string {
  const api = platformOf(context) === "win32" ? nodePath.win32 : nodePath.posix;
  return api.isAbsolute(child) ? api.normalize(child) : joinUnder(context, base, child);
}

function detailFor(argv: ReadonlyArray<string>, stderr: string, exit: number): string {
  const shown = argv.slice(1).join(" ");
  const reason = stderr.trim().length > 0 ? stderr.trim() : `exit ${exit}`;
  return `git ${shown}: ${reason}`;
}

/** Codex `git.rs:173-179`: non-zero is a failure carrying git's own stderr. */
async function runOnce(
  context: WorktreeContext,
  argv: ReadonlyArray<string>,
  cwd: string,
  request: WorktreeEnvRequest,
  operation: WorktreeGitOperation,
): Promise<GitStep> {
  const env = scrubGitEnv(request.baseEnv);
  const hardened =
    operation === "working-tree"
      ? { ...env, ...(await probeFilterEnv(context, cwd, env, request.signal)) }
      : env;

  try {
    const result = await context.runner.run(argv, cwd, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      env: hardened,
    });
    if (result.exit !== 0) {
      return {
        ok: false,
        failure: { ok: false, code: "git_failed", detail: detailFor(argv, result.stderr, result.exit) },
      };
    }

    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (request.signal?.aborted === true) {
      return { ok: false, failure: { ok: false, code: "cancelled", detail: "worktree command was cancelled" } };
    }
    return {
      ok: false,
      failure: {
        ok: false,
        code: "git_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Codex `git.rs:139-171`. Exit 1 from `--get-regexp` means "no filters
 * configured" — the common case, and not a failure. Reading it as one would
 * make every repository without filter drivers unusable.
 */
async function probeFilterEnv(
  context: WorktreeContext,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal | undefined,
): Promise<Readonly<Record<string, string>>> {
  try {
    const probe = await context.runner.run(filterProbeArgv(platformOf(context)), cwd, {
      ...(signal === undefined ? {} : { signal }),
      env,
    });
    if (probe.exit !== 0 && probe.exit !== 1) {
      return {};
    }

    return filterNeuterEnv(parseFilterDriverNames(probe.stdout));
  } catch {
    // Contract: the probe is an optimisation over "run with filters as
    // configured". Losing it must not lose the command, so a failed probe
    // yields no neutering and the caller's command still runs.
    return {};
  }
}

export function runWorktreeGit(
  context: WorktreeContext,
  argv: ReadonlyArray<string>,
  cwd: string,
  request: WorktreeEnvRequest,
  operation: WorktreeGitOperation,
): Promise<GitStep> {
  return runOnce(context, argv, cwd, request, operation);
}

/** Codex `git.rs:58-66`: trimmed, because it is a value not a path. */
export function gitText(step: GitStep): TextStep {
  return step.ok ? step.stdout.trim() : step.failure;
}

/** Codex `git.rs:68-78`: a path, so only the line ending comes off. */
export function gitPathText(step: GitStep): TextStep {
  return step.ok ? step.stdout.replace(/\r?\n$/, "") : step.failure;
}

export async function canonicalize(context: WorktreeContext, path: string): Promise<TextStep> {
  const resolved = await context.io.canonicalize(path);
  return typeof resolved === "string"
    ? resolved
    : { ok: false, code: "unresolved_path", detail: `cannot resolve ${path}: ${resolved.error}` };
}

/** Codex `lib.rs:405-409`. */
export async function repositoryRootOf(
  context: WorktreeContext,
  cwd: string,
  request: WorktreeEnvRequest,
): Promise<TextStep> {
  const step = await runWorktreeGit(context, revParseArgv(platformOf(context), ["--show-toplevel"]), cwd, request, "metadata");
  const text = gitPathText(step);
  if (typeof text !== "string") {
    return text.code === "git_failed"
      ? { ok: false, code: "not_a_repository", detail: `${cwd} is not inside a git repository` }
      : text;
  }

  return canonicalize(context, text);
}

/** Codex `lib.rs:399-403`: `rev-parse <argument>`, resolved against `cwd`. */
export async function gitDirPathOf(
  context: WorktreeContext,
  cwd: string,
  argument: string,
  request: WorktreeEnvRequest,
): Promise<TextStep> {
  const step = await runWorktreeGit(context, revParseArgv(platformOf(context), [argument]), cwd, request, "metadata");
  const text = gitPathText(step);
  return typeof text === "string" ? canonicalize(context, resolveAgainst(context, cwd, text)) : text;
}

/**
 * Codex `lib.rs:363-368`. Canonical form is the point: a symlink pointing out
 * of the checkout would otherwise look like a directory inside it, and the
 * session would start somewhere the user never asked for.
 */
export async function isSafeWorktreeCwd(context: WorktreeContext, root: string, cwd: string): Promise<boolean> {
  const resolvedRoot = await context.io.canonicalize(root);
  const resolvedCwd = await context.io.canonicalize(cwd);
  if (typeof resolvedRoot !== "string" || typeof resolvedCwd !== "string") {
    return false;
  }

  if (!(await context.io.isDirectory(resolvedCwd))) {
    return false;
  }

  return isWithin(resolvedRoot, resolvedCwd, platformOf(context));
}
