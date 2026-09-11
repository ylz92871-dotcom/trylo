// Trylo Desktop — partitioned conversation attachment store
// (P2-1 Work Package B).
//
// One module-level store, strictly partitioned by
// `AttachmentOwner = { surface, projectKey, conversationId }`:
// Code and Work never share an array, project A never leaks into
// project B, conversation A never leaks into conversation B.
//
// React consumes the store through `useConversationAttachments`
// (useSyncExternalStore); the store itself is framework-free and
// unit-testable with injected fakes. All host I/O goes through the
// injected deps (HostAdapter functions) — never a raw invoke.
//
// Send semantics (conservative / recoverable): sending never locks or
// removes attachments. A failed send keeps them; a successful send
// keeps them too (later turns can still reference them). Only
// conversation deletion (`clearConversation`) and workspace close
// (`purgeProject`) destroy state, and those also trigger the Rust
// staging cleanup through the caller.
//
// Persistence: the store never writes conversation history itself.
// Work partitions notify `onWorkAttachmentsChanged` after every commit
// so App.tsx can persist the metadata; on load App calls
// `restoreWork(...)` with the persisted records and this store
// re-validates each staged file via statFile (missing → dropped).

import { hostAdapter } from '../host-adapter';
import { pickFiles } from '../host-adapter/pick-files';
import {
  MAX_ATTACHMENTS_PER_SESSION,
  attachmentFitsLimits,
  attachmentKind,
  type Attachment,
  type FailedAttachment,
} from '../host-adapter/attachment-utils';
import type {
  StageAttachmentArgs,
  StagedAttachment,
} from '../host-adapter/attachment-service';
import {
  joinToRoot,
  runAttachmentAcquisition,
  type AcquisitionIdentity,
  type CreateBlobUrlFn,
  type LiveIdentity,
  type ReadBytesFileFn,
  type ReadTextFileFn,
  type StatFileFn,
  type WorkAttachmentEntry,
} from './attachment-acquisition';

/** Partition identity. Code and Work partitions are disjoint by
 *  construction (the surface is part of the key). */
export interface AttachmentOwner {
  readonly surface: 'code' | 'work';
  readonly projectKey: string;
  readonly conversationId: string;
}

export function ownerKey(owner: AttachmentOwner): string {
  return `${owner.surface}|${owner.projectKey}|${owner.conversationId}`;
}

/** Persisted Work attachment metadata (mirror of what lands in
 *  ConversationRecord.attachments). restoreWork consumes this shape. */
export interface RestoredWorkAttachment {
  readonly id: string;
  readonly name: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly size: number;
}

/** Immutable snapshot React renders from. Reference-stable per key:
 *  only rebuilt when the partition actually changes (required by
 *  useSyncExternalStore). */
export interface AttachmentPartitionSnapshot {
  readonly attachments: readonly Attachment[];
  readonly workAttachments: readonly WorkAttachmentEntry[];
  readonly failed: readonly FailedAttachment[];
  readonly readingCount: number;
}

const EMPTY_SNAPSHOT: AttachmentPartitionSnapshot = {
  attachments: [],
  workAttachments: [],
  failed: [],
  readingCount: 0,
};

/** Host I/O the store needs. Production wiring injects HostAdapter
 *  functions (see the singleton at the bottom); tests inject fakes. */
export interface AttachmentStoreDeps {
  readonly statFile: StatFileFn;
  readonly readText: ReadTextFileFn;
  readonly readBytes: ReadBytesFileFn;
  readonly createBlobUrl: CreateBlobUrlFn;
  readonly revokeBlobUrl: (url: string) => void;
  readonly pickFiles: () => Promise<readonly string[]>;
  readonly stageAttachment: (args: StageAttachmentArgs) => Promise<StagedAttachment>;
}

/** Render-time providers App.tsx installs once. The store asks for
 *  the LIVE identity / workspace root at acquisition time — it never
 *  infers ownership from stale closures. */
export interface AttachmentRuntimeProviders {
  readonly getLiveIdentity: () => LiveIdentity | null;
  readonly getWorkspaceRoot: () => string | null;
  /** Work-only persistence hook: called after every commit that
   *  changed a work partition's entries. App.tsx persists the
   *  metadata into conversation history here. */
  readonly onWorkAttachmentsChanged?: (
    owner: AttachmentOwner,
    entries: readonly WorkAttachmentEntry[],
  ) => void;
}

interface Partition {
  owner: AttachmentOwner;
  attachments: Attachment[];
  workAttachments: WorkAttachmentEntry[];
  failed: FailedAttachment[];
  readingCount: number;
}

export class ConversationAttachmentStore {
  private readonly partitions = new Map<string, Partition>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly snapshots = new Map<string, AttachmentPartitionSnapshot>();
  private providers: AttachmentRuntimeProviders = {
    getLiveIdentity: () => null,
    getWorkspaceRoot: () => null,
  };
  private sequence = 0;

  constructor(private readonly deps: AttachmentStoreDeps) {}

  setRuntimeProviders(providers: AttachmentRuntimeProviders): void {
    this.providers = providers;
  }

  // ── Subscription / snapshot (useSyncExternalStore contract) ──────

  subscribeKey(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(key);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(key);
    };
  }

  snapshotKey(key: string): AttachmentPartitionSnapshot {
    return this.snapshots.get(key) ?? EMPTY_SNAPSHOT;
  }

  subscribe(owner: AttachmentOwner, listener: () => void): () => void {
    return this.subscribeKey(ownerKey(owner), listener);
  }

  snapshot(owner: AttachmentOwner): AttachmentPartitionSnapshot {
    return this.snapshotKey(ownerKey(owner));
  }

  // ── Acquisition ──────────────────────────────────────────────────

  /** Run the shared pipeline for explicit paths (drop handler or the
   *  browser fallback). Picker goes through `openPicker` which lands
   *  here as well — one pipeline, two entry points. */
  async acquireByPaths(owner: AttachmentOwner, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const key = ownerKey(owner);
    const partition = this.ensure(key, owner);

    this.sequence += 1;
    const identity: AcquisitionIdentity = {
      topMode: owner.surface,
      workspaceKey: owner.projectKey,
      conversationId: owner.conversationId,
      sequence: this.sequence,
    };

    partition.readingCount += paths.length;
    this.emit(key);
    try {
      const result = await runAttachmentAcquisition({
        surface: owner.surface,
        identity,
        getLiveIdentity: () => this.liveIdentityOrMismatch(),
        workspaceRoot: this.providers.getWorkspaceRoot(),
        paths,
        statFile: this.deps.statFile,
        readText: this.deps.readText,
        readBytes: this.deps.readBytes,
        createBlobUrl: this.deps.createBlobUrl,
        stageAttachment: this.deps.stageAttachment,
      });
      this.commit(owner, partition, result);
    } finally {
      partition.readingCount = Math.max(0, partition.readingCount - paths.length);
      this.emit(key);
    }
  }

  /** Open the native picker, then acquire the picked paths through
   *  the exact same pipeline as drag-drop. */
  async openPicker(owner: AttachmentOwner): Promise<void> {
    let paths: readonly string[];
    try {
      paths = await this.deps.pickFiles();
    } catch {
      return; // picker error / unavailable: nothing to attach
    }
    if (paths.length === 0) return;
    await this.acquireByPaths(owner, paths);
  }

  /** Remote (mobile Chat mode) attachments: commit directly to the owner's
   *  code partition WITHOUT the live-identity guard — the owner is the
   *  conversation the phone explicitly targeted, not the desktop UI's current
   *  selection (which can legitimately differ during a remote send). The
   *  caller has already materialized each file to disk and built the
   *  `Attachment` (with a real `path`) before calling this. */
  addRemoteAttachments(owner: AttachmentOwner, attachments: readonly Attachment[]): void {
    if (attachments.length === 0) return;
    const key = ownerKey(owner);
    const partition = this.ensure(key, owner);
    const { kept, overflow } = this.fitCap(partition.attachments.length, attachments);
    for (const extra of overflow) this.revokePreview(extra.previewUrl);
    partition.attachments = [...partition.attachments, ...kept];
    this.emit(key);
  }

  // ── Mutation ─────────────────────────────────────────────────────

  remove(owner: AttachmentOwner, id: string): void {
    const key = ownerKey(owner);
    const partition = this.partitions.get(key);
    if (!partition) return;
    const codeHit = partition.attachments.find((a) => a.id === id);
    if (codeHit) {
      this.revokePreview(codeHit.previewUrl);
      partition.attachments = partition.attachments.filter((a) => a.id !== id);
    } else {
      const workHit = partition.workAttachments.find((a) => a.id === id);
      if (!workHit) return;
      this.revokePreview(workHit.previewUrl);
      partition.workAttachments = partition.workAttachments.filter((a) => a.id !== id);
      this.notifyWorkChanged(owner, partition);
    }
    this.emit(key);
  }

  dismissFailed(owner: AttachmentOwner, id: string): void {
    const key = ownerKey(owner);
    const partition = this.partitions.get(key);
    if (!partition) return;
    partition.failed = partition.failed.filter((f) => f.id !== id);
    this.emit(key);
  }

  /** Re-run acquisition for one retryable failure (its source path is
   *  still on record). Non-retryable rejects have no retry affordance
   *  in the UI. */
  retryFailed(owner: AttachmentOwner, failedId: string): void {
    const key = ownerKey(owner);
    const partition = this.partitions.get(key);
    if (!partition) return;
    const hit = partition.failed.find((f) => f.id === failedId && f.retryable === true);
    if (!hit || hit.path.length === 0) return;
    partition.failed = partition.failed.filter((f) => f.id !== failedId);
    this.emit(key);
    void this.acquireByPaths(owner, [hit.path]);
  }

  /** Conversation deletion: drop the partition entirely (revoking
   *  every preview blob). Rust staging cleanup is the caller's job. */
  clearConversation(owner: AttachmentOwner): void {
    this.dropPartition(ownerKey(owner));
  }

  /** Workspace close: drop every partition of the project (both
   *  surfaces). Rust project-level cleanup is the caller's job. */
  purgeProject(projectKey: string): void {
    const keys: string[] = [];
    for (const [key, partition] of this.partitions) {
      if (partition.owner.projectKey === projectKey) keys.push(key);
    }
    for (const key of keys) this.dropPartition(key);
  }

  /** History load (Work only): rebuild entries from persisted
   *  metadata, re-validating each staged file on disk. Missing or
   *  unreadable staged files are silently dropped — a stale record
   *  must never resurface as a broken chip. Does NOT re-invoke the
   *  persistence hook (the records came from history). */
  async restoreWork(
    owner: AttachmentOwner,
    workspaceRoot: string,
    persisted: readonly RestoredWorkAttachment[],
  ): Promise<void> {
    if (persisted.length === 0) return;
    const key = ownerKey(owner);
    const partition = this.ensure(key, owner);
    const entries: WorkAttachmentEntry[] = [];
    for (const record of persisted) {
      // Persistence is validation-only input, never an ownership source.
      // A record must point at the exact conversation/attachment directory
      // that staging created; otherwise a corrupted history file could make
      // one conversation reference another conversation's staged content.
      const expectedPath = `.trylo/attachments/${owner.conversationId}/${record.id}/${record.name}`;
      if (record.relativePath !== expectedPath) continue;
      const stagedPath = joinToRoot(workspaceRoot, record.relativePath);
      try {
        const stat = await this.deps.statFile(stagedPath);
        // The staged file may have been replaced while the app was closed.
        // Requiring an ordinary file keeps symlinks/reparse points and other
        // special entries out of the Work prompt after restart.
        if (stat.isFile !== true || stat.isSymlink === true) continue;
        entries.push({
          id: record.id,
          kind: attachmentKind(record.name),
          name: record.name,
          sourcePath: stagedPath,
          relativePath: record.relativePath,
          size: record.size,
          mediaType: record.mediaType,
          addedAt: Date.now(),
        });
      } catch {
        // Staged file is gone — drop the record.
      }
    }
    if (entries.length === 0) return;
    // Hydration can legitimately be retried (StrictMode, hot reload, or a
    // repeated history load). Merge by attachment id so recovery is
    // idempotent and never consumes the session cap with duplicate chips.
    const merged = new Map(partition.workAttachments.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      if (!merged.has(entry.id)) merged.set(entry.id, entry);
    }
    partition.workAttachments = [...merged.values()].slice(0, MAX_ATTACHMENTS_PER_SESSION);
    this.emit(key);
  }

  // ── Internals ────────────────────────────────────────────────────

  private ensure(key: string, owner: AttachmentOwner): Partition {
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = {
        owner,
        attachments: [],
        workAttachments: [],
        failed: [],
        readingCount: 0,
      };
      this.partitions.set(key, partition);
    }
    return partition;
  }

  private commit(
    owner: AttachmentOwner,
    partition: Partition,
    result: {
      readonly additions: readonly Attachment[];
      readonly workAdditions: readonly WorkAttachmentEntry[];
      readonly failures: readonly FailedAttachment[];
    },
  ): void {
    const key = ownerKey(owner);

    // Late-completion protection: if the user navigated away after
    // the pipeline finished, additions are discarded (with their blob
    // previews revoked) — never committed to a conversation the user
    // left. Failures still land in the owning partition: the reject
    // belongs to the conversation that attempted the attach.
    const stillCurrent = this.isCurrentOwner(owner);

    if (stillCurrent) {
      if (owner.surface === 'code') {
        const { kept, overflow } = this.fitCap(partition.attachments.length, result.additions);
        partition.attachments = [...partition.attachments, ...kept];
        for (const extra of overflow) this.revokePreview(extra.previewUrl);
        partition.failed = [...partition.failed, ...this.overflowFailures(overflow)];
      } else {
        const { kept, overflow } = this.fitCap(partition.workAttachments.length, result.workAdditions);
        partition.workAttachments = [...partition.workAttachments, ...kept];
        for (const extra of overflow) this.revokePreview(extra.previewUrl);
        partition.failed = [...partition.failed, ...this.overflowFailures(overflow)];
        if (kept.length > 0) this.notifyWorkChanged(owner, partition);
      }
    } else {
      for (const a of result.additions) this.revokePreview(a.previewUrl);
      for (const w of result.workAdditions) this.revokePreview(w.previewUrl);
    }

    if (result.failures.length > 0) {
      partition.failed = [...partition.failed, ...result.failures];
    }
    this.emit(key);
  }

  /** Room left in the session cap; returns kept entries + the
   *  overflow that did not fit. */
  private fitCap<T extends { readonly name: string; readonly sourcePath?: string; readonly path?: string }>(
    currentCount: number,
    incoming: readonly T[],
  ): { kept: readonly T[]; overflow: readonly T[] } {
    const room = Math.max(0, MAX_ATTACHMENTS_PER_SESSION - currentCount);
    return { kept: incoming.slice(0, room), overflow: incoming.slice(room) };
  }

  private overflowFailures<T extends { readonly name: string }>(
    overflow: readonly T[],
  ): FailedAttachment[] {
    if (overflow.length === 0) return [];
    const reason = attachmentFitsLimits(MAX_ATTACHMENTS_PER_SESSION);
    const text = reason.ok
      ? `Max ${MAX_ATTACHMENTS_PER_SESSION} attachments per session`
      : reason.reason;
    return overflow.map((o) => ({
      id: `overflow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: o.name,
      path: '',
      reason: text,
    }));
  }

  private isCurrentOwner(owner: AttachmentOwner): boolean {
    const live = this.providers.getLiveIdentity();
    if (live === null) return true; // provider not installed yet
    return live.topMode === owner.surface
      && live.workspaceKey === owner.projectKey
      && live.conversationId === owner.conversationId;
  }

  /** Live identity for the pipeline's per-await re-checks. When no
   *  provider is installed (or it reports null), return an identity
   *  that can match nothing — the pipeline then abandons instead of
   *  guessing an owner. */
  private liveIdentityOrMismatch(): LiveIdentity {
    const live = this.providers.getLiveIdentity();
    if (live !== null) return live;
    return { topMode: 'code', workspaceKey: '\u0000unset', conversationId: '\u0000unset' };
  }

  private notifyWorkChanged(owner: AttachmentOwner, partition: Partition): void {
    if (owner.surface !== 'work') return;
    this.providers.onWorkAttachmentsChanged?.(owner, [...partition.workAttachments]);
  }

  private dropPartition(key: string): void {
    const partition = this.partitions.get(key);
    if (partition) {
      for (const a of partition.attachments) this.revokePreview(a.previewUrl);
      for (const w of partition.workAttachments) this.revokePreview(w.previewUrl);
      this.partitions.delete(key);
    }
    this.snapshots.delete(key);
    this.notify(key);
  }

  private revokePreview(url: string | undefined): void {
    if (url !== undefined) this.deps.revokeBlobUrl(url);
  }

  private emit(key: string): void {
    const partition = this.partitions.get(key);
    this.snapshots.set(key, partition === undefined ? EMPTY_SNAPSHOT : {
      attachments: [...partition.attachments],
      workAttachments: [...partition.workAttachments],
      failed: [...partition.failed],
      readingCount: partition.readingCount,
    });
    this.notify(key);
  }

  private notify(key: string): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const listener of set) listener();
  }
}

// ── Production singleton ───────────────────────────────────────────
// Wired to the HostAdapter (the ONLY entry point for host I/O) and
// the native picker. App.tsx installs the runtime providers once at
// startup. Tests build their own instance with fakes instead.

export const conversationAttachmentStore = new ConversationAttachmentStore({
  statFile: (p) => hostAdapter.fs.statFile(p),
  readText: (p) => hostAdapter.fs.readFile(p),
  readBytes: (p) => hostAdapter.fs.readFileBytes(p),
  createBlobUrl: (bytes, mime) =>
    URL.createObjectURL(new Blob([bytes], { type: mime })),
  revokeBlobUrl: (url) => URL.revokeObjectURL(url),
  pickFiles: async () => (await pickFiles()).paths,
  stageAttachment: (args) => hostAdapter.attachments.stageAttachment(args),
});
