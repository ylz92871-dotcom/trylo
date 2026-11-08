import nodePath from "node:path";
import {
  populateWorktreeArgv,
  resolveCommitArgv,
  setCoreWorktreeArgv,
  worktreeAddArgv,
  worktreeConfigPathArgv,
  worktreeRemoveArgv,
} from "../../domain/worktree-command.js";
import { bucketPath, checkoutPath, relativeWithin, repositoryNameOf } from "../../domain/worktree-layout.js";
import type {
  CreateWorktreeRequest,
  ManagedWorktree,
  WorktreeFailure,
  WorktreeOutcome,
} from "../../ports/worktree.js";
import {
  canonicalize,
  gitPathText,
  gitText,
  isSafeWorktreeCwd,
  joinUnder,
  parentOf,
  platformOf,
  repositoryRootOf,
  runWorktreeGit,
  type TextStep,
  type WorktreeContext,
} from "./worktree-support.js";

/**
 * Creating a managed checkout (WP25.2 / C79, L70).
 *
 * Source: Codex `codex-rs/worktree/src/lib.rs:61-165`, including the two
 * rollback paths. The sequence is deliberate and the order matters:
 *
 *  1. Resolve the repository and the revision to check out. Both are reads.
 *  2. Claim a bucket *before the first write* (`worktree add`), so two
 *     sessions never race for the same directory (`paths.rs:25-37` - create,
 *     not exists-then-create). Claiming after the revision read is safe;
 *     claiming after `worktree add` would be too late, because git would
 *     already have written into a shared directory.
 *  3. `worktree add --detach --no-checkout`, so the checkout exists but is
 *     empty; nothing is materialised until we have pinned its config.
 *  4. Write `core.worktree` into the *destination's* config only. Writing it
 *     to the shared config would silently re-point the user's own repository.
 *  5. `reset --hard` to populate.
 *
 * Every failure after (2) removes what it made, without `--force` where git
 * can refuse and with it only when we are undoing our own half-built state.
 * A checkout that fails at (3) is ours and empty, so force is honest there;
 * nothing the user made can be inside it.
 */

/** Codex `paths.rs:25`: `0..=u16::MAX` attempts before the pool is declared full. */
const BUCKET_ATTEMPTS = 65_535;

type Maybe<T> = T | WorktreeFailure;

function isWorktreeFailure<T>(value: Maybe<T>): value is WorktreeFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function absolutePath(context: WorktreeContext, path: string): boolean {
  const api = platformOf(context) === "win32" ? nodePath.win32 : nodePath.posix;
  return api.isAbsolute(path);
}

async function allocateCheckout(
  context: WorktreeContext,
  poolRoot: string,
  repositoryName: string,
): Promise<Maybe<string>> {
  const ensured = await context.io.ensureDir(poolRoot);
  if (ensured !== undefined) {
    return { ok: false, code: "unresolved_path", detail: `cannot create worktree pool ${poolRoot}: ${ensured.error}` };
  }

  for (let attempt = 0; attempt <= BUCKET_ATTEMPTS; attempt += 1) {
    const hex = context.randomHex().replaceAll("-", "").toLowerCase();
    if (!/^[0-9a-f]{4}/.test(hex)) {
      // The injection seam promised at least four hex characters. Skipping a
      // bad draw keeps the loop total rather than inventing a bucket name.
      continue;
    }

    const bucket = bucketPath(poolRoot, hex.slice(0, 4), platformOf(context));
    const created = await context.io.createDir(bucket);
    if (created === "created") {
      return checkoutPath(bucket, repositoryName, platformOf(context));
    }

    if (created === "exists") {
      continue;
    }

    return { ok: false, code: "unresolved_path", detail: `cannot create worktree bucket ${bucket}: ${created.error}` };
  }

  return {
    ok: false,
    code: "bucket_exhausted",
    detail: `all managed worktree identifiers are in use under ${poolRoot}`,
  };
}

/** Codex `lib.rs:348-361`: undo our own half-built checkout, then reclaim. */
async function rollbackCheckout(
  context: WorktreeContext,
  sourceRoot: string,
  root: string,
  request: CreateWorktreeRequest,
): Promise<WorktreeFailure | undefined> {
  const step = await runWorktreeGit(
    context,
    worktreeRemoveArgv(platformOf(context), root, true),
    sourceRoot,
    request,
    "working-tree",
  );

  await context.io.removeEmptyDir(parentOf(context, root));

  return step.ok ? undefined : step.failure;
}

async function headShaOf(
  context: WorktreeContext,
  sourceRoot: string,
  base: string,
  request: CreateWorktreeRequest,
): Promise<TextStep> {
  return gitText(
    await runWorktreeGit(context, resolveCommitArgv(platformOf(context), base), sourceRoot, request, "working-tree"),
  );
}

export async function createManagedWorktree(
  context: WorktreeContext,
  request: CreateWorktreeRequest,
): Promise<WorktreeOutcome<ManagedWorktree>> {
  const poolRoot = context.settings.root;
  if (!absolutePath(context, poolRoot)) {
    return { ok: false, code: "relative_root", detail: `managed worktree root must be absolute: ${poolRoot}` };
  }

  const sourceCwd = await canonicalize(context, request.sourceCwd);
  if (typeof sourceCwd !== "string") {
    return sourceCwd;
  }

  const sourceRoot = await repositoryRootOf(context, sourceCwd, request);
  if (typeof sourceRoot !== "string") {
    return sourceRoot;
  }

  const relative = relativeWithin(sourceRoot, sourceCwd, platformOf(context));
  if (relative === undefined) {
    return {
      ok: false,
      code: "outside_repository",
      detail: `${sourceCwd} is outside the repository root ${sourceRoot}`,
    };
  }

  const repositoryName = repositoryNameOf(sourceRoot, platformOf(context));
  if (repositoryName === undefined) {
    return { ok: false, code: "unresolved_path", detail: `repository root ${sourceRoot} has no directory name` };
  }

  const headSha = await headShaOf(context, sourceRoot, request.base ?? "HEAD", request);
  if (typeof headSha !== "string") {
    return headSha;
  }

  const root = await allocateCheckout(context, poolRoot, repositoryName);
  if (isWorktreeFailure(root)) {
    return root;
  }

  const added = await runWorktreeGit(context, worktreeAddArgv(platformOf(context), root, headSha), sourceRoot, request, "working-tree");
  if (!added.ok) {
    await context.io.removeEmptyDir(parentOf(context, root));
    return added.failure;
  }

  const populated = await populateCheckout(context, root, headSha, request);
  if (populated !== undefined) {
    const rolledBack = await rollbackCheckout(context, sourceRoot, root, request);
    return rolledBack ?? populated;
  }

  const cwd = joinUnder(context, root, relative);
  if (!(await isSafeWorktreeCwd(context, root, cwd))) {
    const rolledBack = await rollbackCheckout(context, sourceRoot, root, request);
    return (
      rolledBack ?? {
        ok: false,
        code: "outside_repository",
        detail: `requested base does not contain a safe working directory ${relative}`,
      }
    );
  }

  return {
    ok: true,
    value: { root, cwd, sourceRoot, sourceCwd, headSha, branch: undefined },
  };
}

/**
 * Codex `lib.rs:106-145`. Writes the destination config first so the checkout
 * is pinned even where per-worktree configuration is disabled, and only then
 * materialises files. Returns the failure to roll back over, or `undefined`.
 */
async function populateCheckout(
  context: WorktreeContext,
  root: string,
  headSha: string,
  request: CreateWorktreeRequest,
): Promise<WorktreeFailure | undefined> {
  const configStep = await runWorktreeGit(
    context,
    worktreeConfigPathArgv(platformOf(context)),
    root,
    request,
    "metadata",
  );
  const configPath = gitPathText(configStep);
  if (typeof configPath !== "string") {
    return configPath;
  }

  const pinned = await runWorktreeGit(
    context,
    setCoreWorktreeArgv(platformOf(context), configPath, root),
    root,
    request,
    "metadata",
  );
  if (!pinned.ok) {
    return pinned.failure;
  }

  const reset = await runWorktreeGit(
    context,
    populateWorktreeArgv(platformOf(context), headSha),
    root,
    request,
    "working-tree",
  );

  return reset.ok ? undefined : reset.failure;
}
