import { revParseArgv } from "../../domain/worktree-command.js";
import {
  hasManagedLayout,
  parseOwnerRecord,
  WORKTREE_OWNER_FILENAME,
  ownerRecordText,
} from "../../domain/worktree-layout.js";
import type {
  BindOwnerRequest,
  OwnerQueryRequest,
  WorktreeFailure,
  WorktreeOutcome,
} from "../../ports/worktree.js";
import {
  canonicalize,
  gitPathText,
  platformOf,
  resolveAgainst,
  runWorktreeGit,
  type WorktreeContext,
  type WorktreeEnvRequest,
} from "./worktree-support.js";

/**
 * Checkout ownership (WP25.2 / C79, L28).
 *
 * Source: Codex `codex-rs/worktree/src/metadata.rs` and
 * `codex-rs/worktree/src/lib.rs:273-281`.
 *
 * One checkout, one owner, written once. The file lives in the checkout's *git
 * metadata* directory rather than next to the working files for a reason: it
 * must survive a `reset --hard`, and it must not show up as an untracked file
 * that `remove` would then refuse over.
 *
 * Binding is exclusive and idempotent in that order: binding the same owner
 * twice succeeds, binding a *different* owner fails. A second session taking
 * over a checkout that is already running would have two agents writing the
 * same tree with no shared idea of what is in it — the failure is the point,
 * not a limitation to engineer around.
 */

async function ownerFilePath(
  context: WorktreeContext,
  root: string,
  request: WorktreeEnvRequest,
): Promise<string | WorktreeFailure> {
  const step = await runWorktreeGit(
    context,
    revParseArgv(platformOf(context), ["--git-path", WORKTREE_OWNER_FILENAME]),
    root,
    request,
    "metadata",
  );
  const text = gitPathText(step);

  // git may answer with a path already relative to the repository root or an
  // absolute one, depending on configuration. Joining blindly produced
  // `<checkout>/<repo>/.git/...`, which still parsed as "unowned" and so
  // silently allowed a second owner to bind the same checkout.
  return typeof text === "string" ? resolveAgainst(context, root, text) : text;
}

/** Codex `lib.rs:330-345`: the pool owns it, the layout says so. */
async function managedRoot(context: WorktreeContext, root: string): Promise<string | WorktreeFailure> {
  const poolRoot = await canonicalize(context, context.settings.root);
  if (typeof poolRoot !== "string") {
    return poolRoot;
  }

  const checkout = await canonicalize(context, root);
  if (typeof checkout !== "string") {
    return checkout;
  }

  if (!hasManagedLayout(poolRoot, checkout, platformOf(context))) {
    return { ok: false, code: "not_managed", detail: `${checkout} is not a managed worktree` };
  }

  return checkout;
}

export async function ownerOfManagedWorktree(
  context: WorktreeContext,
  request: OwnerQueryRequest,
): Promise<WorktreeOutcome<string | undefined>> {
  const root = await managedRoot(context, request.root);
  if (typeof root !== "string") {
    return root;
  }

  const path = await ownerFilePath(context, root, request);
  if (typeof path !== "string") {
    return path;
  }

  const text = await context.io.readText(path);
  if (typeof text !== "string") {
    // `undefined` is the honest answer "nobody owns this yet"; anything else
    // is a read failure and must be reported, not silently treated as unowned.
    return text === undefined
      ? { ok: true, value: undefined }
      : { ok: false, code: "owner_invalid", detail: `cannot read worktree owner at ${path}` };
  }

  const record = parseOwnerRecord(text);
  if (record === undefined) {
    return { ok: false, code: "owner_invalid", detail: `invalid worktree owner at ${path}` };
  }

  return { ok: true, value: record.ownerId };
}

export async function bindManagedOwner(
  context: WorktreeContext,
  request: BindOwnerRequest,
): Promise<WorktreeOutcome<undefined>> {
  if (request.ownerId.length === 0) {
    return { ok: false, code: "owner_invalid", detail: "worktree owner id cannot be empty" };
  }

  const root = await managedRoot(context, request.root);
  if (typeof root !== "string") {
    return root;
  }

  const existing = await ownerOfManagedWorktree(context, { root: request.root, ...envOf(request) });
  if (!existing.ok) {
    return existing;
  }

  if (existing.value !== undefined) {
    return existing.value === request.ownerId
      ? { ok: true, value: undefined }
      : { ok: false, code: "already_owned", detail: `worktree already belongs to ${existing.value}` };
  }

  const path = await ownerFilePath(context, root, request);
  if (typeof path !== "string") {
    return path;
  }

  const written = await context.io.writeNew(path, ownerRecordText(request.ownerId));
  if (written === "written") {
    return { ok: true, value: undefined };
  }

  if (written === "exists") {
    // Two sessions raced. Whoever got there first wins; if it was us, this is
    // still success. Codex `metadata.rs:76-82` makes the same re-read.
    const after = await ownerOfManagedWorktree(context, { root: request.root, ...envOf(request) });
    if (!after.ok) {
      return after;
    }

    return after.value === request.ownerId
      ? { ok: true, value: undefined }
      : { ok: false, code: "already_owned", detail: "worktree was concurrently assigned to another owner" };
  }

  return { ok: false, code: "unresolved_path", detail: `cannot write worktree owner at ${path}: ${written.error}` };
}

function envOf(request: WorktreeEnvRequest): WorktreeEnvRequest {
  return {
    ...(request.baseEnv === undefined ? {} : { baseEnv: request.baseEnv }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}
