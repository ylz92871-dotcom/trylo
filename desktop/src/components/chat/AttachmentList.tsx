// Trylo Desktop — AttachmentList. See v1.16.2.
//
// Horizontal strip of attachment chips, rendered
// between the input row and the action row in
// InputBar.
//
// v1.16.2.6 chip layout (the "thumbnail" card):
//   - 26×26 kind-tinted icon thumb on the left
//     (image kind shows the real preview if previewUrl
//      is set; falls back to the 🖼️ icon otherwise)
//   - 2-line meta block (name + size) in the middle
//   - × remove button on the right
//
// v1.16.2.6 also adds:
//   - A loading placeholder while files are being read.
//   - Failed-attachment error chips (stat error, file
//     too large, unknown format) so the user can SEE
//     why an attach didn't work — not just console.warn.
//
// Pure presentational — all data flow lives in App.tsx;
// this just renders the array.

import type { ReactElement } from 'react';
import type {
  Attachment,
  AttachmentKind,
  FailedAttachment,
} from '../../host-adapter/attachment-utils';

export interface AttachmentListProps {
  readonly attachments: readonly Attachment[];
  readonly onRemove: (id: string) => void;
  /** v1.16.2.6: number of files currently being read
   *  from disk (post-pick, pre-attach). Renders a
   *  "Reading N file(s)…" placeholder chip with a
   *  spinner when > 0. */
  readonly loading?: number;
  /** v1.16.2.6: visible error feedback for attachments
   *  that failed (stat error, too large, unknown
   *  format). Renders as red-tinted chips with the
   *  reason. */
  readonly failed?: readonly FailedAttachment[];
  /** Called when the user dismisses a failed chip
   *  (clicks the × on it). */
  readonly onDismissFailed?: (id: string) => void;
  /** P2-1 Work Package B: retry handler for retryable failures
   *  (e.g. a transient Work staging copy error). The retry button
   *  renders only when this prop AND the failure's `retryable`
   *  flag are both set — deterministic rejects (too large,
   *  directory, symlink) never offer retry. */
  readonly onRetryFailed?: (id: string) => void;
}

const KIND_ICON: Readonly<Record<AttachmentKind, string>> = {
  office: '📄',
  image: '🖼️',
  text:   '📃',
};

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function AttachmentChip(props: {
  readonly attachment: Attachment;
  readonly onRemove: (id: string) => void;
}): ReactElement {
  const a = props.attachment;
  // v1.16.2.6: image kind gets a real <img> preview if
  // previewUrl is set (App.tsx built the blob: URL after
  // readFileBytes). For everything else (office, text,
  // or image without preview yet) we fall back to the
  // kind icon.
  const isImageWithPreview = a.kind === 'image' && Boolean(a.previewUrl);
  return (
    <span
      className={`attachment-chip attachment-chip--${a.kind}`}
      title={a.path}
    >
      <span className="attachment-chip__thumb" aria-hidden="true">
        {isImageWithPreview
          ? <img
              className="attachment-chip__img"
              src={a.previewUrl}
              alt=""
              draggable={false}
            />
          : KIND_ICON[a.kind]}
      </span>
      <span className="attachment-chip__meta">
        <span className="attachment-chip__name">{a.name}</span>
        <span className="attachment-chip__size">{formatSize(a.size)}</span>
      </span>
      <button
        type="button"
        className="attachment-chip__remove"
        onClick={() => props.onRemove(a.id)}
        aria-label={`Remove ${a.name}`}
        title="Remove attachment"
      >
        ×
      </button>
    </span>
  );
}

function LoadingChip(props: { readonly count: number }): ReactElement {
  return (
    <span
      className="attachment-chip attachment-chip--loading"
      role="status"
      aria-live="polite"
    >
      <span className="attachment-chip__thumb attachment-chip__thumb--loading" aria-hidden="true">
        <span className="attachment-chip__spinner" />
      </span>
      <span className="attachment-chip__meta">
        <span className="attachment-chip__name">
          Reading {props.count} file{props.count === 1 ? '' : 's'}…
        </span>
        <span className="attachment-chip__size">please wait</span>
      </span>
    </span>
  );
}

function FailedChip(props: {
  readonly failed: FailedAttachment;
  readonly onDismiss?: (id: string) => void;
  readonly onRetry?: (id: string) => void;
}): ReactElement {
  const f = props.failed;
  return (
    <span
      className="attachment-chip attachment-chip--failed"
      role="alert"
      title={f.path}
    >
      <span className="attachment-chip__thumb" aria-hidden="true">⚠</span>
      <span className="attachment-chip__meta">
        <span className="attachment-chip__name">{f.name}</span>
        <span className="attachment-chip__size">{f.reason}</span>
      </span>
      {props.onRetry && f.retryable === true && (
        <button
          type="button"
          className="attachment-chip__remove attachment-chip__retry"
          onClick={() => props.onRetry!(f.id)}
          aria-label={`Retry ${f.name}`}
          title="Retry"
        >
          ↻
        </button>
      )}
      {props.onDismiss && (
        <button
          type="button"
          className="attachment-chip__remove"
          onClick={() => props.onDismiss!(f.id)}
          aria-label={`Dismiss ${f.name}`}
          title="Dismiss"
        >
          ×
        </button>
      )}
    </span>
  );
}

export function AttachmentList(props: AttachmentListProps): ReactElement | null {
  const loading = props.loading ?? 0;
  const failed = props.failed ?? [];
  if (props.attachments.length === 0 && loading === 0 && failed.length === 0) {
    return null;
  }
  const ariaLabel =
    props.attachments.length > 0
      ? `${props.attachments.length} attachment${props.attachments.length === 1 ? '' : 's'}`
      : loading > 0
        ? `Reading ${loading} file${loading === 1 ? '' : 's'}`
        : `${failed.length} error${failed.length === 1 ? '' : 's'}`;
  return (
    <div className="attachment-list" role="list" aria-label={ariaLabel}>
      {props.attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} onRemove={props.onRemove} />
      ))}
      {loading > 0 && <LoadingChip count={loading} />}
      {failed.map((f) => (
        <FailedChip
          key={f.id}
          failed={f}
          {...(props.onDismissFailed ? { onDismiss: props.onDismissFailed } : {})}
          {...(props.onRetryFailed ? { onRetry: props.onRetryFailed } : {})}
        />
      ))}
    </div>
  );
}
