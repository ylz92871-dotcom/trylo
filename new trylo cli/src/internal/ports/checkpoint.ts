/**
 * Workspace file checkpointing — the *file* rail of undo.
 *
 * Deliberately separate from transcript rollback (see `ports/compaction.ts`):
 * restoring files must not touch the session journal, and rolling the
 * conversation back must not touch the workspace. Keeping them on two ports is
 * what makes that separation testable instead of merely intended.
 *
 * Storage is snapshot-style directory copying. Git is not a runtime dependency:
 * no repository is required, no history is rewritten, and no external process
 * is consulted. Snapshots live outside the workspace they describe, so a
 * snapshot can never contain itself.
 */

export const CHECKPOINT_FORMAT_VERSION = "1";

/**
 * Directory names never copied. `node_modules` and `.git` are unconditional;
 * anything else (a session directory that happens to sit inside the workspace,
 * say) is supplied by the caller and recorded in the manifest.
 */
export const CHECKPOINT_ALWAYS_IGNORED = ["node_modules", ".git"] as const;

export type CheckpointFileEntry = {
  /** Workspace-relative, POSIX separators. Absolute paths never enter the manifest. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type CheckpointManifest = {
  readonly formatVersion: string;
  readonly checkpointId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Directory names skipped, including the unconditional ones. */
  readonly ignores: readonly string[];
  /**
   * sha256 over the canonical serialization of everything above plus the file
   * list. Tampering with one entry therefore has to break this too, which is
   * what keeps "recompute the digest around edited content" off the table.
   */
  readonly digest: string;
  readonly files: readonly CheckpointFileEntry[];
};

export type SnapshotInput = {
  /** Preparation may stop before any user tool has been dispatched. */
  readonly signal?: AbortSignal;
  /**
   * Must resolve to the store's own root. Accepted as an input so callers state
   * what they believe they are snapshotting, and refused when that belief is
   * wrong — restoring into a tree that was never snapshotted is not a thing
   * this port will guess at.
   */
  readonly workspaceRoot: string;
  readonly label: string;
  readonly createdAt: string;
};

export type SnapshotOutcome = {
  readonly checkpointId: string;
  readonly manifest: CheckpointManifest;
};

export type RestoreInput = {
  readonly checkpointId: string;
};

export type RestoreOutcome = {
  readonly restoredFiles: number;
  readonly removedFiles: number;
};

export type CheckpointSummary = {
  readonly checkpointId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly digest: string;
};

export type CheckpointFailureCode =
  | "checkpoint_root_mismatch"
  | "checkpoint_not_found"
  | "workspace_missing"
  | "storage_unavailable"
  | "manifest_unreadable"
  | "manifest_malformed"
  | "checksum_mismatch"
  | "size_limit_exceeded"
  | "snapshot_interrupted"
  | "snapshot_cancelled"
  | "restore_interrupted";

export type CheckpointFailure = {
  readonly ok: false;
  readonly code: CheckpointFailureCode;
  readonly detail: string;
};

export type CheckpointResult<T> =
  | { readonly ok: true; readonly value: T }
  | CheckpointFailure;

export type CheckpointStoreOptions = {
  readonly workspaceRoot: string;
  /** Outside `workspaceRoot` by construction; validated rather than assumed. */
  readonly storageRoot: string;
  readonly ignores?: readonly string[];
  /** Refuse absurd workspaces instead of copying them and hoping. */
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
};

export const CHECKPOINT_DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const CHECKPOINT_DEFAULT_MAX_FILES = 20_000;

export type CheckpointPort = {
  snapshot(input: SnapshotInput): Promise<CheckpointResult<SnapshotOutcome>>;
  restore(input: RestoreInput): Promise<CheckpointResult<RestoreOutcome>>;
  list(): Promise<CheckpointResult<readonly CheckpointSummary[]>>;
};
