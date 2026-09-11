// Trylo Desktop — shared attachment acquisition pipeline
// (P2-1 Work Package B). Generalized from drag-drop-attach.ts
// (P2-1 A-Edge): BOTH surfaces and BOTH entry points (picker +
// drag-drop) flow through this one pipeline, dispatched by surface:
//
//   - code: quick stat → text excerpt → image blob preview.
//     Behavior is the legacy one, unchanged (no staging; the agent
//     reads the user's path via FileRead).
//   - work: stat pre-check → Rust staging copy-in
//     (hostAdapter.attachments.stageAttachment) → workspace-relative
//     descriptor. Image previews read the STAGED copy — never the raw
//     external path — so the chip preview goes through the validated
//     workspace-controlled file.
//
// Ownership guard (A-Edge pattern): the caller captures an
// AcquisitionIdentity at acquisition start; the pipeline re-reads the
// LIVE identity at every await boundary. A mismatch means the user
// switched surface / workspace / conversation mid-flight — that file's
// writes are abandoned, never committed to the wrong owner.

import {
  attachmentKind,
  attachmentMediaType,
  buildAttachmentExcerpt,
  fileSizeFitsLimit,
  newAttachmentId,
  type Attachment,
  type AttachmentKind,
  type FailedAttachment,
} from '../host-adapter/attachment-utils';
import type {
  StageAttachmentArgs,
  StagedAttachment,
} from '../host-adapter/attachment-service';
import type { WorkAttachmentDescriptor } from '@trylo/work';

export type AcquisitionSurface = 'code' | 'work';

/** Identity of the conversation an acquisition targets, captured at
 *  the moment the acquisition started (drop event / picker commit).
 *  A later render that disagrees with this identity means the user
 *  navigated away during async acquisition; those writes are
 *  abandoned. */
export interface AcquisitionIdentity {
  readonly topMode: AcquisitionSurface;
  readonly workspaceKey: string;
  readonly conversationId: string | null;
  /** Bumped on every acquisition so the caller's closure always
   *  points at the freshest pending work. */
  readonly sequence: number;
}

/** The live (render-time) identity shape the pipeline compares
 *  against at every await. */
export interface LiveIdentity {
  readonly topMode: AcquisitionSurface;
  readonly workspaceKey: string;
  readonly conversationId: string | null;
}

/** A function returning the IDENTITY of the conversation the user is
 *  currently looking at. Called between every await. Must be cheap
 *  (no I/O). */
export type IdentityGetter = () => LiveIdentity;

/** Read a file's stat. isDirectory/isFile are optional so tests can
 *  supply a minimal { size } fake. */
export type StatFileFn = (path: string) => Promise<{
  readonly size: number;
  readonly isDirectory?: boolean;
  readonly isFile?: boolean;
  readonly isSymlink?: boolean;
}>;

/** Read a text file. */
export type ReadTextFileFn = (path: string) => Promise<string>;

/** Read a file's bytes (for image previews). */
export type ReadBytesFileFn = (path: string) => Promise<Uint8Array>;

/** Create a blob: URL for an image preview. */
export type CreateBlobUrlFn = (bytes: Uint8Array, mime: string) => string;

/** One staged Work attachment — the partition-store record. Carries
 *  the original source path (for retry/diagnostics) plus the
 *  workspace-relative staged path (the ONLY path that ever reaches a
 *  prompt). */
export interface WorkAttachmentEntry {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mediaType: string;
  readonly addedAt: number;
  readonly previewUrl?: string;
}

/** Project a store entry into the prompt descriptor (pure data, no
 *  absolute paths). */
export function toWorkDescriptor(
  entry: WorkAttachmentEntry,
): WorkAttachmentDescriptor {
  return {
    id: entry.id,
    name: entry.name,
    relativePath: entry.relativePath,
    mediaType: entry.mediaType,
    size: entry.size,
  };
}

/** Map a Work entry onto the shared chip view shape so Work and Code
 *  render through the SAME AttachmentList. `path` carries the staged
 *  workspace-relative path (tooltip) — never the raw external path. */
export function workAttachmentToView(entry: WorkAttachmentEntry): Attachment {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    path: entry.relativePath,
    size: entry.size,
    mediaType: entry.mediaType,
    excerpt: '',
    addedAt: entry.addedAt,
    ...(entry.previewUrl !== undefined ? { previewUrl: entry.previewUrl } : {}),
  };
}

/** Result of one acquisition run. The caller (the partition store)
 *  decides how to commit additions / failures — this helper never
 *  mutates any state itself. */
export interface AcquisitionResult {
  /** Code-surface additions (empty when surface === 'work'). */
  readonly additions: readonly Attachment[];
  /** Work-surface staged entries (empty when surface === 'code'). */
  readonly workAdditions: readonly WorkAttachmentEntry[];
  readonly failures: readonly FailedAttachment[];
  /** True when at least one file was abandoned because the user
   *  navigated away during async acquisition. */
  readonly abandonedForNavigation: boolean;
}

const MAX_FILES_PER_ACQUISITION = 6;

/** Per-file outcome used to accumulate results. */
interface FileOutcome {
  readonly path: string;
  readonly attachment?: Attachment;
  readonly workEntry?: WorkAttachmentEntry;
  readonly failure?: FailedAttachment;
}

const ABANDONED_OUTCOME: FileOutcome = { path: '' };

/** Deterministic staging rejects must not offer retry (the file will
 *  be rejected again identically). Transient failures (IO error,
 *  mid-copy size mismatch from a concurrent write) ARE retryable.
 *  Patterns mirror the strings produced by attachment_staging.rs +
 *  the local pre-checks below. */
const NON_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /too large/i,
  /not a file/i,
  /not a regular file/i,
  /can't attach a directory/i,
  /directory/i,
  /symlink/i,
  /special file/i,
  /already staged/i,
  /not a plain file/i,
  /containment|escaped/i,
  /invalid/i,
];

export function isRetryableFailure(reason: string): boolean {
  return !NON_RETRYABLE_PATTERNS.some((re) => re.test(reason));
}

/** Join a workspace-relative staged path onto a root, picking the
 *  separator that matches the root (Windows roots use '\'; the staged
 *  relative path is always forward-slashed and both Rust and the dev
 *  backend accept either). */
export function joinToRoot(root: string, relativePath: string): string {
  if (root.endsWith('/') || root.endsWith('\\')) return `${root}${relativePath}`;
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root}${sep}${relativePath}`;
}

/** Run the shared attach pipeline for one acquisition (one drop OR
 *  one picker commit). I/O happens only through the caller-supplied
 *  functions — the pipeline itself is testable without React or a
 *  Tauri runtime.
 *
 *  @param identity Captured at acquisition start; never re-read from
 *  any closure.
 *  @param getLiveIdentity Called between every await. A mismatch
 *  abandons the in-flight file.
 *  @param workspaceRoot Required for the work surface (staging anchor
 *  + preview reads). Null on the work surface fails every file with a
 *  visible reason instead of staging into nowhere.
 */
export async function runAttachmentAcquisition(args: {
  readonly surface: AcquisitionSurface;
  readonly identity: AcquisitionIdentity;
  readonly getLiveIdentity: IdentityGetter;
  readonly workspaceRoot: string | null;
  readonly paths: readonly string[];
  readonly statFile: StatFileFn;
  readonly readText: ReadTextFileFn;
  readonly readBytes: ReadBytesFileFn;
  readonly createBlobUrl: CreateBlobUrlFn;
  readonly stageAttachment: (args: StageAttachmentArgs) => Promise<StagedAttachment>;
}): Promise<AcquisitionResult> {
  const { identity, getLiveIdentity, paths } = args;

  if (paths.length === 0) {
    return { additions: [], workAdditions: [], failures: [], abandonedForNavigation: false };
  }

  // Work surface without an open workspace cannot stage — fail every
  // file visibly rather than silently dropping the drop.
  if (args.surface === 'work' && (args.workspaceRoot === null || identity.conversationId === null)) {
    const reason = args.workspaceRoot === null
      ? 'No workspace is open — attachments need a project to stage into.'
      : 'No Work conversation is open yet.';
    return {
      additions: [],
      workAdditions: [],
      failures: paths.map((p) => ({
        id: newAttachmentId(),
        name: basenameOf(p) || p,
        path: p,
        reason,
      })),
      abandonedForNavigation: false,
    };
  }

  const abandoned = { value: false };
  const outcomes: FileOutcome[] = [];
  for (const p of paths) {
    // Bail-out check #1: still on the same surface, workspace and
    // conversation as when the acquisition started.
    if (!sameIdentity(identity, getLiveIdentity())) {
      abandoned.value = true;
      break;
    }
    const outcome = args.surface === 'work'
      ? await acquireWorkFile(args, p)
      : await acquireCodeFile(args, p);
    if (outcome === ABANDONED_OUTCOME) {
      abandoned.value = true;
      break;
    }
    outcomes.push(outcome);
  }

  // Final identity re-check after the loop — if the user navigated
  // away while the LAST file was processed, mark abandoned.
  if (!sameIdentity(identity, getLiveIdentity())) {
    abandoned.value = true;
  }

  const additions: Attachment[] = [];
  const workAdditions: WorkAttachmentEntry[] = [];
  const failures: FailedAttachment[] = [];
  for (const o of outcomes) {
    if (o.attachment) additions.push(o.attachment);
    if (o.workEntry) workAdditions.push(o.workEntry);
    if (o.failure) failures.push(o.failure);
  }

  // Fully abandoned with nothing to show → one visible notice, never
  // a silent drop.
  if (additions.length === 0 && workAdditions.length === 0
      && failures.length === 0 && abandoned.value) {
    failures.push({
      id: newAttachmentId(),
      name: 'attachment',
      path: '',
      reason: 'Attachment was abandoned because the conversation or workspace changed during acquisition.',
    });
  }

  return {
    additions: additions.slice(0, MAX_FILES_PER_ACQUISITION),
    workAdditions: workAdditions.slice(0, MAX_FILES_PER_ACQUISITION),
    failures,
    abandonedForNavigation: abandoned.value,
  };
}

// ── Code surface (legacy behavior, unchanged) ──────────────────────

async function acquireCodeFile(
  args: Parameters<typeof runAttachmentAcquisition>[0],
  p: string,
): Promise<FileOutcome> {
  const { identity, getLiveIdentity, statFile, readText, readBytes, createBlobUrl } = args;
  const kind = attachmentKind(p);
  const mediaType = attachmentMediaType(p);
  const name = basenameOf(p) || p;
  const failure = (reason: string): FailedAttachment => ({
    id: newAttachmentId(), name, path: p, reason,
  });

  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  let size = 0;
  try {
    const s = await statFile(p);
    size = s.size;
  } catch (err) {
    return { path: p, failure: failure(`can't read file: ${errorMessage(err)}`) };
  }
  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  const sizeCheck = fileSizeFitsLimit(kind, size);
  if (!sizeCheck.ok) {
    return { path: p, failure: failure(sizeCheck.reason) };
  }

  let textContent: string | null = null;
  if (kind === 'text') {
    if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;
    try { textContent = await readText(p); } catch { /* ignore */ }
  }
  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  let previewUrl: string | undefined;
  if (kind === 'image') {
    if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;
    try {
      const bytes = await readBytes(p);
      previewUrl = createBlobUrl(bytes, imageMimeOf(p, mediaType));
    } catch { /* ignore — chip falls back to the icon */ }
  }

  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  return {
    path: p,
    attachment: {
      id: newAttachmentId(),
      kind, name, path: p, size, mediaType,
      excerpt: buildAttachmentExcerpt(kind, name, mediaType, textContent),
      addedAt: Date.now(),
      ...(previewUrl !== undefined ? { previewUrl } : {}),
    },
  };
}

// ── Work surface (staging copy-in) ─────────────────────────────────

async function acquireWorkFile(
  args: Parameters<typeof runAttachmentAcquisition>[0],
  p: string,
): Promise<FileOutcome> {
  const { identity, getLiveIdentity, workspaceRoot, statFile, readBytes, createBlobUrl, stageAttachment } = args;
  const kind = attachmentKind(p);
  const mediaType = attachmentMediaType(p);
  const name = basenameOf(p) || p;
  const failure = (reason: string, retryable: boolean): FailedAttachment => ({
    id: newAttachmentId(), name, path: p, reason,
    ...(retryable ? { retryable: true } : {}),
  });

  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  // Pre-check stat: cheap early rejects (missing file, directory,
  // oversize) before invoking the Rust staging command. The Rust side
  // re-validates everything — this is UX, not the security boundary.
  let stat: { size: number; isDirectory?: boolean; isFile?: boolean };
  try {
    stat = await statFile(p);
  } catch (err) {
    return { path: p, failure: failure(`can't read file: ${errorMessage(err)}`, true) };
  }
  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  if (stat.isDirectory) {
    return { path: p, failure: failure("Can't attach a directory", false) };
  }
  if (stat.isFile === false) {
    return { path: p, failure: failure('Not a regular file', false) };
  }
  const sizeCheck = fileSizeFitsLimit(kind, stat.size);
  if (!sizeCheck.ok) {
    return { path: p, failure: failure(sizeCheck.reason, false) };
  }

  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  // The staging copy. attachmentId is minted BEFORE the copy so each
  // attachment gets its own staging directory (no same-name clobber).
  const attachmentId = newAttachmentId();
  let staged: StagedAttachment;
  try {
    staged = await stageAttachment({
      workspaceRoot: workspaceRoot ?? '',
      conversationId: identity.conversationId ?? '',
      attachmentId,
      sourcePath: p,
    });
  } catch (err) {
    const reason = errorMessage(err);
    return { path: p, failure: failure(reason, isRetryableFailure(reason)) };
  }
  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  // Image preview reads the STAGED copy (workspace-controlled path),
  // never the raw external source. Best-effort like Code.
  let previewUrl: string | undefined;
  if (kind === 'image') {
    try {
      const bytes = await readBytes(joinToRoot(workspaceRoot ?? '', staged.relativePath));
      previewUrl = createBlobUrl(bytes, imageMimeOf(staged.name, mediaType));
    } catch { /* ignore — chip falls back to the icon */ }
  }

  if (!sameIdentity(identity, getLiveIdentity())) return ABANDONED_OUTCOME;

  return {
    path: p,
    workEntry: {
      id: attachmentId,
      kind,
      name: staged.name,
      sourcePath: p,
      relativePath: staged.relativePath,
      size: staged.size,
      mediaType: mediaType || 'application/octet-stream',
      addedAt: Date.now(),
      ...(previewUrl !== undefined ? { previewUrl } : {}),
    },
  };
}

// ── Shared helpers ─────────────────────────────────────────────────

function sameIdentity(a: AcquisitionIdentity, b: LiveIdentity): boolean {
  return a.topMode === b.topMode
    && a.workspaceKey === b.workspaceKey
    && a.conversationId === b.conversationId;
}

function imageMimeOf(path: string, mediaType: string): string {
  if (mediaType) return mediaType;
  const ext = path.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? '';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function basenameOf(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}
