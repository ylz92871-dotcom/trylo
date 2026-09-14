// Trylo Desktop — Project State. See ARCHITECTURE.md §2.3.
//
// The key correctness invariant of the whole system. Project State is
// the source of truth. The agent does not own Monaco, Monaco does not
// own the agent. Both read from and write to the filesystem through a
// unified Workspace model. The IDE auto-detects external changes
// through a WorkspaceWatcher.

import type { FilePath } from '../host-adapter/types';

// ── Workspace ──────────────────────────────────────────────────────────────

export interface FileBuffer {
  readonly path: FilePath;
  /** Current content visible to the user (in-memory mirror of disk + edits). */
  readonly content: string;
  /** True when `content` differs from the last on-disk state. */
  readonly dirty: boolean;
  /** Cursor position + selection. */
  readonly selection: TextSelection;
  /** Monotonic version, bumped on every save. */
  readonly version: number;
}

export interface TextSelection {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface Workspace {
  readonly root: FilePath;
  /** All open buffers, keyed by path. */
  readonly buffers: ReadonlyMap<FilePath, FileBuffer>;
  /** Currently focused buffer. */
  readonly activeBuffer: FilePath | null;
}

// ── ChangeSet (pending) ────────────────────────────────────────────────────

export interface ChangeSet {
  readonly id: string;
  /** Files touched in this changeset, in order. */
  readonly files: readonly ChangeSetFile[];
  readonly createdAt: number;
  readonly author: 'user' | 'agent' | 'system';
}

export interface ChangeSetFile {
  readonly path: FilePath;
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly before?: string;
  readonly after?: string;
}

// ── Audit ──────────────────────────────────────────────────────────────────

export type AuditStage =
  | 'implementation'
  | 'code-review'
  | 'architecture-review'
  | 'specialist-review'
  | 'security-review'
  | 'final-audit';

export interface AuditEntry {
  readonly id: string;
  readonly stage: AuditStage;
  readonly status: 'pending' | 'passed' | 'flagged' | 'rejected';
  readonly notes: string;
  readonly createdAt: number;
}

// ── Read-only views ────────────────────────────────────────────────────────
//
// Memory and Skills are projections of Trylo Core's state. The desktop
// shell never writes to them — only reads. Writes flow back through
// HostAdapter → Trylo Core.

export interface MemoryView {
  readonly layers: {
    readonly user: number;
    readonly project: number;
    readonly team: number;
    readonly working: number;
  };
}

export interface SkillsView {
  readonly total: number;
  readonly proposed: number;
  readonly approved: number;
}
