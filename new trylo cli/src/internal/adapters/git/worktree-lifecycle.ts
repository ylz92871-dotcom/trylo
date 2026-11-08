import {
  ignoredFilesArgv,
  parseWorktreeList,
  worktreeListArgv,
  worktreeRemoveArgv,
} from "../../domain/worktree-command.js";
import { hasManagedLayout, isWithin, relativeWithin } from "../../domain/worktree-layout.js";
import type {
  ListWorktreesRequest,
  ManagedWorktree,
  RemoveWorktreeRequest,
  WorktreeOutcome,
} from "../../ports/worktree.js";
import {
  canonicalize,
  gitDirPathOf,
  isSafeWorktreeCwd,
  joinUnder,
  parentOf,
  platformOf,
  repositoryRootOf,
  resolveAgainst,
  runWorktreeGit,
  type TextStep,
  type WorktreeContext,
  type WorktreeEnvRequest,
} from "./worktree-support.js";

/**
 * Listing and removing managed checkouts (WP25.2 / C79, L70).
 *
 * Source: Codex `codex-rs/worktree/src/lib.rs:167-271` and `:284-328`.
 *
 * `list` is where the promise "a checkout we did not create is not ours" is
 * actually kept, and it is kept four times over, because each check fails on a
 * different lie:
 *
 *  - **Layout.** Outside the `<bucket>/<name>` shape, so a hand-made worktree
 *    is invisible here and therefore unreachable by `remove`.
 *  - **`.git` is a file.** A linked checkout points at its git directory; the
 *    primary checkout *contains* one. This alone excludes the user's own repo.
 *  - **Same common directory.** A stale registration left behind by a deleted
 *    repository would otherwise be adopted into this one.
 *  - **Backlink.** The administration directory must point back at this exact
 *    checkout, not at a different one that reused the path.
 *
 * `remove` refuses rather than forces, in three places: you cannot delete the
 * checkout you are standing in, you cannot delete one holding ignored local
 * files, and — by handing `git worktree remove` no `--force` — you cannot
 * delete one with tracked changes. Losing a person's uncommitted work is not
 * an acceptable price for a tidy pool.
 */

/**
 * Codex `lib.rs:231-251`. The administration directory records which checkout
 * it belongs to; without this, a registration whose directory was recycled
 * would let one checkout answer for another.
 */
async function backlinkMatches(
  context: WorktreeContext,
  canonicalRoot: string,
  request: WorktreeEnvRequest,
): Promise<boolean> {
  const gitDir = await gitDirPathOf(context, canonicalRoot, "--git-dir", request);
  if (typeof gitDir !== "string") {
    return false;
  }

  const raw = await context.io.readText(joinUnder(context, gitDir, "gitdir"));
  if (typeof raw !== "string") {
    return false;
  }

  const target = raw.trim();
  if (target.length === 0) {
    return false;
  }

  const backlink = await context.io.canonicalize(resolveAgainst(context, gitDir, target));
  const gitFile = await context.io.canonicalize(joinUnder(context, canonicalRoot, ".git"));

  return typeof backlink === "string" && typeof gitFile === "string" && backlink === gitFile;
}

export async function listManagedWorktrees(
  context: WorktreeContext,
  request: ListWorktreesRequest,
): Promise<WorktreeOutcome<ReadonlyArray<ManagedWorktree>>> {
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

  const poolRoot = context.settings.root;
  const canonicalPool = await context.io.canonicalize(poolRoot);
  const resolvedPool = typeof canonicalPool === "string" ? canonicalPool : poolRoot;
  const sourceCommonDir: TextStep = await gitDirPathOf(context, sourceRoot, "--git-common-dir", request);
  if (typeof sourceCommonDir !== "string") {
    return sourceCommonDir;
  }

  const listed = await runWorktreeGit(context, worktreeListArgv(platformOf(context)), sourceCwd, request, "metadata");
  if (!listed.ok) {
    return listed.failure;
  }

  const found: ManagedWorktree[] = [];

  for (const entry of parseWorktreeList(listed.stdout)) {
    const bucket = parentOf(context, entry.root);
    if (!(await context.io.isDirectory(entry.root)) || !(await context.io.isDirectory(bucket))) {
      continue;
    }

    const canonicalRoot = await context.io.canonicalize(entry.root);
    const root = typeof canonicalRoot === "string" ? canonicalRoot : entry.root;
    const linkedGitFile = await context.io.isFile(joinUnder(context, root, ".git"));
    if (!hasManagedLayout(resolvedPool, root, platformOf(context)) || !linkedGitFile) {
      continue;
    }

    const commonDir = await gitDirPathOf(context, root, "--git-common-dir", request);
    if (typeof commonDir !== "string" || commonDir !== sourceCommonDir) {
      continue;
    }

    if (!(await backlinkMatches(context, root, request))) {
      continue;
    }

    const cwd = joinUnder(context, entry.root, relative);
    if (!(await isSafeWorktreeCwd(context, root, cwd))) {
      continue;
    }

    if (entry.headSha === undefined) {
      // Codex `lib.rs:257-258` fails the whole listing rather than dropping
      // the entry: a managed checkout with no HEAD is a broken one, and
      // silently omitting it would make the pool look cleaner than it is.
      return { ok: false, code: "git_failed", detail: `managed worktree ${entry.root} has no HEAD` };
    }

    found.push({
      root: entry.root,
      cwd,
      sourceRoot,
      sourceCwd,
      headSha: entry.headSha,
      branch: entry.branch,
    });
  }

  found.sort((left, right) => (left.root < right.root ? -1 : left.root > right.root ? 1 : 0));

  return { ok: true, value: found };
}

export async function removeManagedWorktree(
  context: WorktreeContext,
  request: RemoveWorktreeRequest,
): Promise<WorktreeOutcome<undefined>> {
  const listed = await listManagedWorktrees(context, {
    sourceCwd: request.sourceCwd,
    ...(request.baseEnv === undefined ? {} : { baseEnv: request.baseEnv }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (!listed.ok) {
    return listed;
  }

  const checkout = listed.value.find((item) => item.root === request.root);
  if (checkout === undefined) {
    return { ok: false, code: "not_managed", detail: `${request.root} is not a managed worktree in this repository` };
  }

  const sourceCwd = await canonicalize(context, request.sourceCwd);
  if (typeof sourceCwd !== "string") {
    return sourceCwd;
  }

  const checkoutRoot = await canonicalize(context, checkout.root);
  if (typeof checkoutRoot !== "string") {
    return checkoutRoot;
  }

  // Codex `lib.rs:300-302`: deleting the checkout you are standing in would
  // remove the directory the running session is using.
  if (isWithin(checkoutRoot, sourceCwd, platformOf(context))) {
    return { ok: false, code: "current_checkout", detail: "switch to another checkout before deleting the current worktree" };
  }

  const ignored = await runWorktreeGit(context, ignoredFilesArgv(platformOf(context)), checkout.root, request, "working-tree");
  if (!ignored.ok) {
    return ignored.failure;
  }

  if (ignored.stdout.length > 0) {
    return { ok: false, code: "has_ignored_files", detail: "worktree contains ignored local files; remove them before deleting it" };
  }

  // No `--force`: git itself refuses a checkout with modified or untracked
  // tracked files, which is the last line of defence for the user's work.
  const removed = await runWorktreeGit(
    context,
    worktreeRemoveArgv(platformOf(context), request.root, false),
    checkout.sourceRoot,
    request,
    "working-tree",
  );
  if (!removed.ok) {
    return removed.failure;
  }

  await context.io.removeEmptyDir(parentOf(context, request.root));

  return { ok: true, value: undefined };
}
