import { readFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseManifest } from "../../adapters/checkpoint/manifest.js";
import type { CheckpointManifest } from "../../ports/checkpoint.js";
import {
  filesDirectory,
  manifestPathOf,
  nativeJoin,
  sha256Of,
  storePaths,
  writeAtomic,
} from "../../adapters/checkpoint/support.js";
import { ignoreSet, listWorkspaceFiles } from "../../adapters/checkpoint/walk.js";
import type { CurrentRow, SnapshotRow } from "../../adapters/checkpoint/scope-restore.js";

/**
 * The checkpoint-vs-workspace reads shared by `checkpoint diff` and scoped
 * `checkpoint restore` (WP11/F3, F12).
 *
 * One implementation for both commands, because a preview that counts
 * different files than the restore it previews would be the exact lie F12
 * describes. Both read the manifest the store wrote (including the ignore
 * set it snapshotted with) and hash the live tree with the store's own
 * walk + digest — the same rows `applyRestore` verifies against, minus the
 * restore itself.
 */

export type ManifestRead =
  | { readonly ok: true; readonly manifest: CheckpointManifest }
  | { readonly ok: false; readonly code: "checkpoint_not_found" | "manifest_unreadable" | "manifest_malformed" | "checksum_mismatch" | "checkpoint_id_mismatch"; readonly detail: string };

/**
 * Reads and validates one manifest. The id check mirrors `applyRestore`:
 * a manifest whose embedded id differs from the requested file is never
 * the checkpoint it claims to describe.
 */
export function readManifest(storageRoot: string, checkpointId: string): ManifestRead {
  const manifestPath = manifestPathOf(storePaths(storageRoot), checkpointId);
  let text: string;

  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, code: "checkpoint_not_found", detail: checkpointId };
  }

  const parsed = parseManifest(text);
  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.manifest.checkpointId !== checkpointId) {
    return { ok: false, code: "checkpoint_id_mismatch", detail: `${checkpointId} != ${parsed.manifest.checkpointId}` };
  }

  return { ok: true, manifest: parsed.manifest };
}

export function manifestRows(manifest: CheckpointManifest): ReadonlyArray<SnapshotRow> {
  return manifest.files.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes }));
}

export type WorkspaceRead =
  | { readonly ok: true; readonly rows: ReadonlyArray<CurrentRow>; readonly unreadable: ReadonlyArray<string> }
  | { readonly ok: false; readonly code: "workspace_missing"; readonly detail: string };

/** Hashes the live tree under the manifest's own ignore set (F12). */
export function readCurrentRows(workspaceRoot: string, ignores: ReadonlyArray<string>): WorkspaceRead {
  const walked = listWorkspaceFiles(workspaceRoot, ignoreSet(ignores));
  if (!walked.ok) {
    return { ok: false, code: "workspace_missing", detail: walked.detail };
  }

  const rows: CurrentRow[] = [];
  const unreadable: string[] = [];

  for (const file of walked.files) {
    try {
      rows.push({ path: file.relativePath, sha256: sha256Of(file.absolutePath), bytes: file.bytes });
    } catch {
      unreadable.push(file.relativePath);
    }
  }

  return { ok: true, rows, unreadable };
}

/**
 * The real-filesystem IO behind a scoped plan: snapshot bytes come from the
 * checkpoint's own files directory, workspace writes go through the store's
 * atomic writer. Kept here (not in the pure planner) so tests inject fakes
 * while production reuses the exact write path `applyRestore` uses.
 */
export function scopedPlanIo(storageRoot: string, checkpointId: string, workspaceRoot: string) {
  const filesRoot = filesDirectory(storePaths(storageRoot), checkpointId);
  return {
    async readSnapshot(relativePath: string): Promise<Uint8Array> {
      return readFileSync(nativeJoin(filesRoot, relativePath));
    },

    async writeFile(relativePath: string, data: Uint8Array): Promise<void> {
      const destination = nativeJoin(workspaceRoot, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeAtomic(destination, Buffer.from(data));
    },

    async removeFile(relativePath: string): Promise<void> {
      rmSync(nativeJoin(workspaceRoot, relativePath), { force: true });
    },
  };
}
