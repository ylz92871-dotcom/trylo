// Trylo Desktop — attachment utilities. See v1.16.2.
//
// Ported from the legacy mini-vscode-agent attachment
// system (extension.js:177-201 + webview-script) and
// trimmed for the desktop. The desktop does NOT copy
// files into a `.trylo/attachments/` directory — the
// file picker returns an absolute path in the user's
// workspace, and the agent reads it via its own
// FileRead tool. This sidesteps the desktop's text-only
// hostAdapter.fs (no binary read/write) and keeps the
// data flow simpler: pick → record → inject into prompt.
//
// Three attachment kinds: office (docx/xlsx/pptx/pdf),
// image (png/jpg/jpeg/webp/gif), text (everything else).
// Limits mirror the old code's ATTACHMENT_LIMITS
// (extension.js:177): 1 MB text, 25 MB office, 1 MB
// image, 6 per session.
//
// Read old code at:
//   - extension.js:177 (ATTACHMENT_LIMITS)
//   - extension.js:2692-2840 (buildAttachmentExcerpt,
//     buildImageAttachmentExcerpt, buildOfficeAttachmentExcerpt,
//     sanitizeSessionAttachment, buildAttachmentPromptContext)
//   - office-attachment-utils.js (MIME map + path builder)
// Reuses: settings-store (none), nothing in desktop yet.
// Do NOT: copy the file into a hidden directory. The
// CLI's FileRead tool can open the user's path directly.

// v1.16.2.6: bumped the per-kind size limits after
// user review. The previous 1MB / 25MB caps were too
// tight for real-world code + doc workflows (the user
// had files up to ~8MB they wanted to attach). The
// new limits are 10x more generous. The token cost
// of large files is borne by the CLI when it reads
// them — the desktop just gates the UX so a giant
// file doesn't lock the picker / show a tiny chip.
export const MAX_ATTACHMENTS_PER_SESSION = 6;
export const MAX_ATTACHMENT_BYTES_TEXT = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENT_BYTES_OFFICE = 50 * 1024 * 1024; // 50 MB
export const MAX_ATTACHMENT_BYTES_IMAGE = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENT_EXCERPT_CHARS = 220;

export type AttachmentKind = 'office' | 'image' | 'text';

export interface Attachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  /** basename, e.g. "contract.docx". */
  readonly name: string;
  /** Absolute path the file picker returned. The agent
   *  reads it via FileRead. */
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
  /** Short preview for the prompt context. For binary
   *  kinds this is a label like "Office attachment:
   *  contract.docx (application/...)"; for text it's the
   *  first MAX_ATTACHMENT_EXCERPT_CHARS chars of the file. */
  readonly excerpt: string;
  readonly addedAt: number;
  // v1.16.2.6: optional blob: URL used as an <img src>
  // for image previews. Created by App.tsx via
  // URL.createObjectURL after readFileBytes. Must be
  // revoked when the attachment is removed (App.tsx
  // handles the cleanup).
  readonly previewUrl?: string;
}

/**
 * v1.16.2.6: a "soft-failed" attachment. The desktop
 * tried to attach this file but couldn't (permission,
 * file too large, unknown format, etc.) — the user
 * needs to SEE this, not just have it logged. App.tsx
 * collects these into a separate array and renders them
 * as red-tinted chips in the attachment strip so the
 * user knows exactly which file was rejected and why.
 */
export interface FailedAttachment {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly reason: string;
  // P2-1 Work Package B: a retryable failure keeps its source
  // path valid for one more acquisition attempt (e.g. a Work
  // staging copy that failed transiently). Non-retryable
  // rejections (directory, oversized, symlink) leave this unset.
  readonly retryable?: boolean;
}

const OFFICE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['.doc',  'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls',  'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt',  'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.pdf',  'application/pdf'],
]);

const IMAGE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  // v1.16.2.6: expanded from 4 to 12 formats. The user
  // reported "I can't upload images" in tauri:dev — the
  // picker's IMAGE filter only matched .png/.jpg/.jpeg/
  // .webp/.gif, so a .heic phone photo, a .tiff scan,
  // an .svg logo, etc. were silently rejected by both
  // the picker filter AND the desktop's kind classifier.
  // The desktop's attachment kind now recognises a
  // broader set; the Tauri picker's filter is widened in
  // host-adapter/pick-files.ts.
  ['.png',  'image/png'],
  ['.jpg',  'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif',  'image/gif'],
  ['.bmp',  'image/bmp'],
  ['.tiff', 'image/tiff'],
  ['.tif',  'image/tiff'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.svg',  'image/svg+xml'],
  ['.avif', 'image/avif'],
  ['.ico',  'image/x-icon'],
]);

/** Lowercased extension including the dot, or ''. */
function extOf(p: string): string {
  const m = p.toLowerCase().match(/\.[^./\\]+$/);
  return m ? m[0] : '';
}

/** Classify a file path into one of the three kinds. */
export function attachmentKind(path: string): AttachmentKind {
  const e = extOf(path);
  if (OFFICE_MEDIA_TYPES.has(e)) return 'office';
  if (IMAGE_MEDIA_TYPES.has(e)) return 'image';
  return 'text';
}

/** The MIME type for a path, or '' if unknown. */
export function attachmentMediaType(path: string): string {
  const e = extOf(path);
  return OFFICE_MEDIA_TYPES.get(e) ?? IMAGE_MEDIA_TYPES.get(e) ?? '';
}

/** Per-kind size limit (bytes). */
export function attachmentSizeLimit(kind: AttachmentKind): number {
  if (kind === 'office') return MAX_ATTACHMENT_BYTES_OFFICE;
  if (kind === 'image') return MAX_ATTACHMENT_BYTES_IMAGE;
  return MAX_ATTACHMENT_BYTES_TEXT;
}

/** Generate an attachment id, matching the old code's
 *  shape so cross-tooling the logs feels familiar. */
export function newAttachmentId(): string {
  return `attachment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the excerpt string that goes into the prompt
 *  context. The caller is responsible for reading the
 *  text content (we keep this function pure / IO-free). */
export function buildAttachmentExcerpt(
  kind: AttachmentKind,
  name: string,
  mediaType: string,
  textContent: string | null,
): string {
  if (kind === 'office') {
    return `Office attachment: ${name}${mediaType ? ` (${mediaType})` : ''}`;
  }
  if (kind === 'image') {
    return `Image attachment: ${name}${mediaType ? ` (${mediaType})` : ''}`;
  }
  if (textContent && textContent.trim()) {
    return truncateText(textContent.trim(), MAX_ATTACHMENT_EXCERPT_CHARS);
  }
  return `Text attachment: ${name} (empty)`;
}

/** Result of fitting new attachment against the session
 *  limits. ok=false carries a one-line human reason
 *  suitable for a toast. */
export type AttachmentLimitCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Count check: is there room for one more attachment?
 *  Caller still has to check per-file size separately
 *  via fileSizeFitsLimit (which needs the kind). */
export function attachmentFitsLimits(
  currentCount: number,
): AttachmentLimitCheck {
  if (currentCount >= MAX_ATTACHMENTS_PER_SESSION) {
    return {
      ok: false,
      reason: `Max ${MAX_ATTACHMENTS_PER_SESSION} attachments per session`,
    };
  }
  return { ok: true };
}

export function fileSizeFitsLimit(
  kind: AttachmentKind,
  sizeBytes: number,
): AttachmentLimitCheck {
  const limit = attachmentSizeLimit(kind);
  if (sizeBytes > limit) {
    return {
      ok: false,
      reason: `File too large (${formatBytes(sizeBytes)} > ${formatBytes(limit)})`,
    };
  }
  return { ok: true };
}

/** Build the prompt-context block that gets prepended
 *  to a user message. Returns '' for an empty list so
 *  callers can `if (ctx) message = ctx + '\n\n' + message`
 *  without conditional noise. */
export function buildAttachmentPromptContext(
  attachments: readonly Attachment[],
): string {
  if (attachments.length === 0) return '';
  const lines: string[] = [
    '[Session attachments]',
    'These files are attached to the current session. Read them with your file tools when relevant.',
  ];
  for (const a of attachments) {
    const size = formatBytes(a.size);
    const kindLabel =
      a.kind === 'office' ? 'Office' : a.kind === 'image' ? 'Image' : 'Text';
    const mediaType = a.mediaType ? ` (${a.mediaType})` : '';
    lines.push(`- ${a.name} [${kindLabel}${mediaType}, ${size}] at ${a.path}`);
    if (a.excerpt) {
      lines.push(`  excerpt: ${a.excerpt}`);
    }
  }
  return lines.join('\n');
}

// ── Internal helpers ───────────────────────────────────

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
