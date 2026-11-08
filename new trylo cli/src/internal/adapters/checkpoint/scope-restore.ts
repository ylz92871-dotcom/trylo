/**
 * Scoped checkpoint comparison and restore (WP11.2, L37).
 *
 * Mechanical reuse of the old `fileHistory.ts` ideas — per-file backup
 * entries, "file did not exist" as an explicit state rather than a guess,
 * and compare-before-write — over the new whole-workspace snapshots. The
 * difference from both the old rewind and the current full `applyRestore`
 * is the scope: only paths named in `scope` are ever written or removed.
 * A file the user created after the checkpoint that is not in scope is
 * reported as kept, never deleted. That is what makes "rewind this task"
 * disjoint from "wipe my other work".
 *
 * Pure planning plus a small injected-IO applier. Hashing and directory
 * reads stay with the caller (the store, the walk); this module only sees
 * `{ path, sha256, bytes }` rows.
 */

export type SnapshotRow = {
  /** Workspace-relative, POSIX separators — the manifest key. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
};

export type CurrentRow = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
};

export type CheckpointDiff = {
  /** Present now, absent in the snapshot. */
  readonly added: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  /** In the snapshot, absent now. */
  readonly removed: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  /** Same path, different bytes. */
  readonly modified: ReadonlyArray<{ readonly path: string; readonly beforeBytes: number; readonly afterBytes: number }>;
  readonly unchangedCount: number;
};

/**
 * What `checkpoint diff` shows: snapshot rows against current rows, sorted
 * by path. Rows are matched by path only; content equality is by sha256.
 */
export function diffSnapshot(
  snapshot: ReadonlyArray<SnapshotRow>,
  current: ReadonlyArray<CurrentRow>,
): CheckpointDiff {
  const before = new Map(snapshot.map((row) => [row.path, row]));
  const now = new Map(current.map((row) => [row.path, row]));
  const added: Array<{ path: string; bytes: number }> = [];
  const removed: Array<{ path: string; bytes: number }> = [];
  const modified: Array<{ path: string; beforeBytes: number; afterBytes: number }> = [];
  let unchangedCount = 0;

  for (const [path, row] of now) {
    const old = before.get(path);
    if (old === undefined) {
      added.push({ path, bytes: row.bytes });
    } else if (old.sha256 !== row.sha256) {
      modified.push({ path, beforeBytes: old.bytes, afterBytes: row.bytes });
    } else {
      unchangedCount += 1;
    }
  }

  for (const [path, row] of before) {
    if (!now.has(path)) {
      removed.push({ path, bytes: row.bytes });
    }
  }

  const byPath = (left: { path: string }, right: { path: string }): number =>
    left.path < right.path ? -1 : 1;

  return {
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    modified: modified.sort(byPath),
    unchangedCount,
  };
}

export type ScopedAction =
  | { readonly action: "overwrite" | "recreate"; readonly path: string; readonly bytes: number }
  | { readonly action: "remove"; readonly path: string }
  | { readonly action: "none"; readonly path: string };

export type ScopedPlan = {
  /** Writes and recreations, in path order. Applied before removals. */
  readonly writes: ReadonlyArray<Extract<ScopedAction, { action: "overwrite" | "recreate" }>>;
  readonly removals: ReadonlyArray<Extract<ScopedAction, { action: "remove" }>>;
  /** Scope paths already identical: explicitly no work, not skipped work. */
  readonly alreadyCurrent: ReadonlyArray<string>;
  /**
   * Files that differ or appeared outside the scope. Untouched by the
   * applier, listed so the person can see what the rewind did *not* take.
   */
  readonly keptOutsideScope: ReadonlyArray<string>;
};

export type ScopedPlanOutcome =
  | { readonly ok: true; readonly plan: ScopedPlan }
  | { readonly ok: false; readonly code: "unknown_scope_path" | "empty_scope"; readonly detail: string };

/**
 * Plans a rewind limited to `scope`. Scope paths are exact: a path known
 * neither to the snapshot nor to the current tree is refused rather than
 * guessed at. An empty scope is a usage error, not a no-op success — "rewind
 * nothing" must be said out loud.
 */
export function planScopedRestore(input: {
  readonly snapshot: ReadonlyArray<SnapshotRow>;
  readonly current: ReadonlyArray<CurrentRow>;
  readonly scope: ReadonlyArray<string>;
}): ScopedPlanOutcome {
  if (input.scope.length === 0) {
    return { ok: false, code: "empty_scope", detail: "a scoped rewind with no paths would change nothing" };
  }

  const before = new Map(input.snapshot.map((row) => [row.path, row]));
  const now = new Map(input.current.map((row) => [row.path, row]));
  const inScope = new Set(input.scope);

  for (const path of inScope) {
    if (!before.has(path) && !now.has(path)) {
      return { ok: false, code: "unknown_scope_path", detail: `scoped path is in neither the snapshot nor the workspace: ${path}` };
    }
  }

  const writes: Array<Extract<ScopedAction, { action: "overwrite" | "recreate" }>> = [];
  const removals: Array<Extract<ScopedAction, { action: "remove" }>> = [];
  const alreadyCurrent: string[] = [];

  for (const path of [...inScope].sort()) {
    const old = before.get(path);
    const row = now.get(path);

    if (old === undefined) {
      if (row !== undefined) {
        removals.push({ action: "remove", path });
      }
      continue;
    }

    if (row === undefined) {
      writes.push({ action: "recreate", path, bytes: old.bytes });
    } else if (row.sha256 !== old.sha256) {
      writes.push({ action: "overwrite", path, bytes: old.bytes });
    } else {
      alreadyCurrent.push(path);
    }
  }

  const keptOutsideScope = [...now.keys()].filter((path) => !inScope.has(path)).sort();

  return { ok: true, plan: { writes, removals, alreadyCurrent, keptOutsideScope } };
}

export type ScopedRestoreIo = {
  readSnapshot(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  removeFile(path: string): Promise<void>;
};

export type ScopedRestoreOutcome =
  | { readonly ok: true; readonly value: { readonly restoredFiles: number; readonly removedFiles: number } }
  | {
    readonly ok: false;
    readonly code: "restore_interrupted";
    readonly detail: string;
    /** What had already landed when the failure hit. Never silent. */
    readonly completed: { readonly restoredFiles: number; readonly removedFiles: number };
  };

/**
 * Applies a scoped plan: replacements first, removals second. The order is
 * the same argument `restore.ts` makes — an interruption during replacement
 * leaves the tree closer to the snapshot than removing first would — and a
 * failure reports what already landed so restoring again converges.
 */
export async function applyScopedPlan(plan: ScopedPlan, io: ScopedRestoreIo): Promise<ScopedRestoreOutcome> {
  let restoredFiles = 0;

  try {
    for (const write of plan.writes) {
      const data = await io.readSnapshot(write.path);
      await io.writeFile(write.path, data);
      restoredFiles += 1;
    }
  } catch (error) {
    return {
      ok: false,
      code: "restore_interrupted",
      detail: error instanceof Error ? error.message : String(error),
      completed: { restoredFiles, removedFiles: 0 },
    };
  }

  let removedFiles = 0;

  try {
    for (const removal of plan.removals) {
      await io.removeFile(removal.path);
      removedFiles += 1;
    }
  } catch (error) {
    return {
      ok: false,
      code: "restore_interrupted",
      detail: error instanceof Error ? error.message : String(error),
      completed: { restoredFiles, removedFiles },
    };
  }

  return { ok: true, value: { restoredFiles, removedFiles } };
}
