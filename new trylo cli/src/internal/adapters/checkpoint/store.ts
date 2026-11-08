import { readdirSync, readFileSync } from "node:fs";
import {
  CHECKPOINT_DEFAULT_MAX_FILES,
  CHECKPOINT_DEFAULT_MAX_TOTAL_BYTES,
  type CheckpointPort,
  type CheckpointResult,
  type CheckpointStoreOptions,
  type CheckpointSummary,
} from "../../ports/checkpoint.js";
import { parseManifest } from "./manifest.js";
import { applyRestore } from "./restore.js";
import { takeSnapshot } from "./snapshot.js";
import {
  failureOf,
  guardStorage,
  manifestPathOf,
  resolveExistingWorkspace,
  resolveWorkspace,
  storePaths,
} from "./support.js";
import { ignoreSet, listSnapshotFiles } from "./walk.js";

/**
 * Snapshot-style workspace checkpointing — the *file* rail of undo.
 *
 * What shaped this design:
 *  - no git. A runtime dependency on a repository would make checkpoints
 *    unavailable exactly when a workspace is dirty or unversioned, and would make
 *    undo rewrite real history;
 *  - storage always lives outside the workspace, so a snapshot cannot contain
 *    itself. Enforced in `support.ts`, not requested of callers;
 *  - `restore` only ever moves files. The transcript rail (`ports/compaction.ts`
 *    and `internal/compaction/**`) never touches this tree, which is what makes
 *    "conversation rollback must not undo work, and file restore must not edit
 *    history" a property rather than a promise.
 *
 * This file wires the three operations; each one's policy lives in its own module.
 */

export function createFileCheckpointStore(options: CheckpointStoreOptions): CheckpointPort {
  const ignores = ignoreSet(options.ignores ?? []);
  const ignoredNames = [...ignores];
  const maxTotalBytes = options.maxTotalBytes ?? CHECKPOINT_DEFAULT_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? CHECKPOINT_DEFAULT_MAX_FILES;

  return {
    async snapshot(input) {
      const root = resolveWorkspace(options.workspaceRoot, input.workspaceRoot);
      if (!root.ok) {
        return failureOf(root.code, root.detail);
      }

      const paths = storePaths(options.storageRoot);
      const guarded = guardStorage(root.path, paths.storageRoot);
      if (!guarded.ok) {
        return failureOf(guarded.code, guarded.detail);
      }

      const walked = await listSnapshotFiles(root.path, ignores, input.signal);
      if (!walked.ok) {
        return input.signal?.aborted ? failureOf("snapshot_cancelled", "checkpoint preparation cancelled")
          : failureOf("workspace_missing", walked.detail);
      }

      return takeSnapshot({
        paths,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        label: input.label,
        createdAt: input.createdAt,
        files: walked.files,
        ignoredNames,
        maxFiles,
        maxTotalBytes,
      });
    },

    async restore(input) {
      const root = resolveExistingWorkspace(options.workspaceRoot);
      if (!root.ok) {
        return failureOf(root.code, root.detail);
      }

      return applyRestore({
        paths: storePaths(options.storageRoot),
        workspaceRoot: root.path,
        checkpointId: input.checkpointId,
        ignoredNames,
      });
    },

    async list() {
      return listSummaries(options.storageRoot);
    },
  };
}

/**
 * A damaged recovery point is reported, never skipped: the caller has to learn
 * that one of its undo points is gone *before* it needs it.
 */
function listSummaries(storageRoot: string): CheckpointResult<readonly CheckpointSummary[]> {
  let entries;

  try {
    entries = readdirSync(storageRoot, { withFileTypes: true });
  } catch (error) {
    return failureOf("storage_unavailable", String(error));
  }

  const summaries: CheckpointSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    let parsed;

    try {
      parsed = parseManifest(readFileSync(manifestPathOf(storePaths(storageRoot), entry.name), "utf8"));
    } catch (error) {
      return failureOf("manifest_unreadable", String(error));
    }

    if (!parsed.ok) {
      return failureOf(parsed.code, parsed.detail);
    }

    summaries.push({
      checkpointId: parsed.manifest.checkpointId,
      label: parsed.manifest.label,
      createdAt: parsed.manifest.createdAt,
      fileCount: parsed.manifest.fileCount,
      totalBytes: parsed.manifest.totalBytes,
      digest: parsed.manifest.digest,
    });
  }

  summaries.sort((left, right) => (left.checkpointId < right.checkpointId ? -1 : 1));

  return { ok: true, value: summaries };
}
