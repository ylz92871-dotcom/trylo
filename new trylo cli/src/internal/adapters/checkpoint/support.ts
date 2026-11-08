import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckpointFailure, CheckpointFailureCode } from "../../ports/checkpoint.js";

/**
 * Mechanics shared by snapshot and restore: where the store points, which tree
 * it believes it is talking about, and how bytes are written and hashed.
 *
 * Policy is deliberately absent from this file. Everything here answers "how";
 * what may be undone is decided in `snapshot.ts` and `restore.ts`.
 */

export type StorePaths = {
  readonly storageRoot: string;
  readonly checkpointRoot: (checkpointId: string) => string;
};

export function failureOf(code: CheckpointFailureCode, detail: string): CheckpointFailure {
  return { ok: false, code, detail };
}

export function storePaths(storageRoot: string): StorePaths {
  return {
    storageRoot,
    checkpointRoot: (checkpointId: string) => path.join(storageRoot, checkpointId),
  };
}

export function filesDirectory(paths: StorePaths, checkpointId: string): string {
  return path.join(paths.checkpointRoot(checkpointId), "files");
}

export function manifestPathOf(paths: StorePaths, checkpointId: string): string {
  return path.join(paths.checkpointRoot(checkpointId), "manifest.json");
}

/** A manifest `path` is always relative and POSIX; this maps it back to disk. */
export function nativeJoin(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * The caller states what it believes it is checkpointing; agreeing with the
 * store is a precondition, not a nicety. A mismatch means one of them drifted,
 * and restoring onto the wrong tree is not something this port attempts.
 */
export function resolveWorkspace(
  configuredRoot: string,
  claimedRoot: string,
):
  | { ok: true; path: string }
  | { ok: false; code: "checkpoint_root_mismatch" | "workspace_missing"; detail: string } {
  let configured: string;
  let claimed: string;

  try {
    configured = realpathSync(configuredRoot);
    claimed = realpathSync(claimedRoot);
  } catch (error) {
    return { ok: false, code: "workspace_missing", detail: String(error) };
  }

  if (configured !== claimed) {
    return { ok: false, code: "checkpoint_root_mismatch", detail: `${claimed} != ${configured}` };
  }

  return { ok: true, path: configured };
}

export function resolveExistingWorkspace(
  configuredRoot: string,
): { ok: true; path: string } | { ok: false; code: "workspace_missing"; detail: string } {
  try {
    return { ok: true, path: realpathSync(configuredRoot) };
  } catch (error) {
    return { ok: false, code: "workspace_missing", detail: String(error) };
  }
}

/** Storage nested inside its own subject would snapshot the snapshot. */
export function guardStorage(
  workspaceRoot: string,
  storageRoot: string,
): { ok: true } | { ok: false; code: "storage_unavailable"; detail: string } {
  try {
    mkdirSync(storageRoot, { recursive: true });
  } catch (error) {
    return { ok: false, code: "storage_unavailable", detail: String(error) };
  }

  let resolved: string;

  try {
    resolved = realpathSync(storageRoot);
  } catch (error) {
    return { ok: false, code: "storage_unavailable", detail: String(error) };
  }

  const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (resolved === workspaceRoot || resolved.startsWith(prefix)) {
    return { ok: false, code: "storage_unavailable", detail: "storage inside workspace" };
  }

  return { ok: true };
}

export function sha256Of(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

/** Temp-then-rename: a crashed write cannot leave a half file behind. */
export function writeAtomic(destination: string, content: string | Buffer): void {
  const temporary = `${destination}.trylo-partial`;
  writeFileSync(temporary, content);
  renameSync(temporary, destination);
}

export function discard(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Best effort: the caller receives the failure either way.
  }
}
