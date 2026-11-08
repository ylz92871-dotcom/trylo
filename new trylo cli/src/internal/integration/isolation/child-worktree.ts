import {
  WORKTREE_OWNER_FILENAME,
} from "../../domain/worktree-layout.js";
import type {
  WorktreeFailureCode,
  WorktreeOutcome,
  WorktreePort,
} from "../../ports/worktree.js";

/**
 * Subagent worktree isolation (WP25.2 / L28).
 *
 * Source: Codex `codex-rs/exec/src/worktree.rs` (allocation around the run) and
 * `codex-rs/exec/src/lib.rs:1087-1091` (bind the owner once the run has an id).
 * The old CLI's `AgentTool` worktree branch was the TS-side precedent.
 *
 * The whole point is that a child agent cannot edit its parent's working tree:
 * it gets a checkout of its own, and the parent can take the diff afterwards.
 * Two consequences follow, and both are the reason this is a lease rather than
 * a convenience call:
 *
 *  - **The lease is bound to the child, not to the code.** Isolation that
 *    outlives the child is not isolation; the whole point of a worktree is
 *    that the diff can be handed back and the worktree released. `release`
 *    therefore refuses exactly as hard as it acquired.
 *  - **A failed lease is a refusal, never a fallback.** Running the child in
 *    the parent's directory "because the worktree could not be created" would
 *    hand it the parent's uncommitted files with a different name on them. The
 *    caller gets `ok: false` and decides.
 *
 * Neither path decides *when* a child should be isolated — that is the caller's
 * policy. This module owns the lifetime.
 */

export type WorktreeLeaseRequest = {
  readonly parentCwd: string;
  /** The child's identity: a subagent id, not a display name. */
  readonly childId: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
};

export type WorktreeLease = {
  readonly root: string;
  /** Where the child's tools must run. */
  readonly cwd: string;
  readonly headSha: string;
};

export type WorktreeLeaseFailure = {
  readonly ok: false;
  readonly code: WorktreeFailureCode;
  readonly detail: string;
};

export type WorktreeLeaseOutcome =
  | { readonly ok: true; readonly lease: WorktreeLease }
  | WorktreeLeaseFailure;

/**
 * What became of the checkout on release. The three cases are genuinely
 * different to a caller — "gone", "still there with the child's work in it",
 * "still there because we were not allowed to touch it" — so collapsing them
 * into one `undefined` would leave the only interesting outcome unreportable.
 */
export type WorktreeRelease =
  | { readonly state: "removed" }
  /**
   * The child left work behind. Not a failure: the changes *are* the
   * deliverable, so the directory survives for the caller to collect.
   */
  | { readonly state: "kept"; readonly reason: "child_has_changes" }
  | { readonly state: "kept"; readonly reason: WorktreeFailureCode; readonly detail: string };

export type IsolatedChildRunner = {
  /** Creates the checkout and binds the child as its owner. */
  lease(request: WorktreeLeaseRequest): Promise<WorktreeLeaseOutcome>;
  /**
   * Hands the checkout back, and always says what happened to it. This is not
   * advisory: a caller that cannot tell "deleted" from "kept" cannot go and
   * collect a diff, and would report a clean result for work that is still
   * sitting on disk.
   */
  release(
    lease: WorktreeLease,
    parentCwd: string,
    options?: { readonly baseEnv?: Readonly<Record<string, string | undefined>>; readonly signal?: AbortSignal },
  ): Promise<WorktreeRelease>;
};

export function createIsolatedChildRunner(worktrees: WorktreePort): IsolatedChildRunner {
  return {
    async lease(request): Promise<WorktreeLeaseOutcome> {
      if (request.childId.length === 0) {
        return { ok: false, code: "owner_invalid", detail: "child id cannot be empty" };
      }

      const created = await worktrees.create({
        sourceCwd: request.parentCwd,
        ...(request.baseEnv === undefined ? {} : { baseEnv: request.baseEnv }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (!created.ok) {
        return created;
      }

      // Binding after creation rather than before: the checkout has no metadata
      // directory until git has made it, so an earlier write would have nowhere
      // to land.
      const bound = await worktrees.bindOwner({
        root: created.value.root,
        ownerId: request.childId,
        ...(request.baseEnv === undefined ? {} : { baseEnv: request.baseEnv }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (!bound.ok) {
        // The checkout exists but nobody owns it, so it would linger in every
        // later listing. Undo it under the same rules a failure in `create`
        // uses; if that also fails, the caller is told both facts.
        const removed = await worktrees.remove({
          sourceCwd: request.parentCwd,
          root: created.value.root,
          ...(request.baseEnv === undefined ? {} : { baseEnv: request.baseEnv }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        return removed.ok
          ? bound
          : {
              ok: false,
              code: removed.code,
              detail: `${bound.detail}; the unowned checkout also could not be removed: ${removed.detail}`,
            };
      }

      return {
        ok: true,
        lease: { root: created.value.root, cwd: created.value.cwd, headSha: created.value.headSha },
      };
    },

    async release(lease, parentCwd, options) {
      const outcome: WorktreeOutcome<undefined> = await worktrees.remove({
        sourceCwd: parentCwd,
        root: lease.root,
        ...(options?.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (outcome.ok) {
        return { state: "removed" };
      }

      if (outcome.code === "has_ignored_files") {
        // The child's uncommitted work lives here. That is the answer a caller
        // wants — "it made changes, go and look" — and it is not an error to
        // have produced it.
        return { state: "kept", reason: "child_has_changes" };
      }

      return { state: "kept", reason: outcome.code, detail: outcome.detail };
    },
  };
}

/**
 * Codex `metadata.rs:19` names the record for Desktop; here it is
 * `WORKTREE_OWNER_FILENAME`. Re-exported so a caller diagnosing "why does this
 * checkout have no owner" does not have to reach into the domain for a filename.
 */
export { WORKTREE_OWNER_FILENAME };
