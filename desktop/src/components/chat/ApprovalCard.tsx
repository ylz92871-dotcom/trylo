// Trylo Desktop — ApprovalCard (P3, spec §4.5 / §3.3).
//
// Renders an inline permission request from EITHER authority:
//   - `authority: 'work'`  → `onRespond(approvalId, approved)` routes
//     through `WorkRuntime.respondApproval`;
//   - `authority: 'code'`  → `onRespond(requestId, approved)` routes
//     through `CodePermissionRegistry.respond` (via the
//     `ApprovalService`).
//
// The card is the only place that calls `onRespond`. Clicking the
// card body or the "查看变更" button opens the right-side diff panel
// through `onOpenPreview` — it NEVER auto-approves. Approve / Deny
// are the only mutating actions; both are disabled for a non-pending
// card (approved / denied / expired).
//
// Expired / cancelled state: when a process exits or the daemon
// rejects a request, the host updates the card to `expired` (or
// `denied` for explicit cancel) so the buttons cannot be pressed on
// a stale request.

import { useState, type ReactElement } from 'react';
import { ShieldAlert, ShieldCheck, ShieldX, Eye, FileText, Terminal, Globe, Monitor } from 'lucide-react';
import type { ApprovalMessage } from './types';
import type { ApprovalPreview, ApprovalDiffPreview } from '../../approval/approval-preview';

export interface ApprovalCardProps {
  readonly message: ApprovalMessage;
  /** Work path → `WorkRuntime.respondApproval`. Code path →
   *  `CodePermissionRegistry.respond` via `ApprovalService`. */
  readonly onRespond?: (id: string, approved: boolean) => void;
  /** Open the right-side diff panel. The id passed back is the
   *  stable `approvalId` (Work) or `requestId` (Code). Never
   *  triggers `onRespond`. */
  readonly onOpenPreview?: (id: string) => void;
}

const TYPE_LABELS: Readonly<Record<string, string>> = {
  run_command: 'Command',
  write_file: 'Write file',
  edit_file: 'Edit file',
  read_file: 'Read file',
  web_search: 'Web search',
  http_request: 'HTTP request',
  Write: 'Edit file',
  Edit: 'Edit file',
  MultiEdit: 'Edit file',
  Bash: 'Run command',
  WebFetch: 'Web fetch',
  WebSearch: 'Web search',
};

function typeLabel(type: string | undefined): string {
  if (type === undefined) return 'Permission request';
  return TYPE_LABELS[type] ?? type;
}

function formatDiffStats(diff: ApprovalDiffPreview | undefined): string {
  if (!diff) return '';
  const parts: string[] = [];
  if (typeof diff.additions === 'number') parts.push(`+${diff.additions}`);
  if (typeof diff.deletions === 'number') parts.push(`−${diff.deletions}`);
  return parts.join('  ');
}

function previewMeta(preview: ApprovalPreview | undefined): {
  icon: typeof Eye;
  primary: string;
  detail: string;
} {
  if (!preview) {
    return { icon: ShieldAlert, primary: '', detail: '' };
  }
  switch (preview.kind) {
    case 'diff':
      return {
        icon: FileText,
        primary: preview.target ?? preview.title,
        detail: formatDiffStats(preview.diff),
      };
    case 'command':
      return {
        icon: Terminal,
        primary: preview.command ?? preview.title,
        detail: preview.cwd ? `目录 ${preview.cwd}` : '',
      };
    case 'network':
      return {
        icon: Globe,
        primary: preview.target ?? preview.title,
        detail: '外部请求',
      };
    case 'desktop':
      return {
        icon: Monitor,
        primary: preview.actionLabel ?? preview.title,
        detail: preview.reason ?? '',
      };
    case 'summary':
      return { icon: FileText, primary: preview.target ?? preview.title, detail: preview.reason ?? '' };
    case 'unavailable':
    default:
      return {
        icon: Eye,
        primary: preview.target ?? preview.title,
        detail: preview.reason ?? '此请求未提供可预览补丁',
      };
  }
}

export function ApprovalCard(props: ApprovalCardProps): ReactElement {
  const m = props.message;
  const [submitting, setSubmitting] = useState(false);
  const resolved = m.status !== 'pending';
  const meta = previewMeta(m.preview);

  const respond = (approved: boolean): void => {
    if (!props.onRespond || resolved || submitting) return;
    setSubmitting(true);
    try {
      props.onRespond(m.approvalId, approved);
    } finally {
      // Keep the card interactive for optimistic UX; the host
      // flips the status on a granted/denied follow-up and
      // disables the buttons via `resolved`.
      setSubmitting(false);
    }
  };

  const openPreview = (): void => {
    if (!props.onOpenPreview) return;
    props.onOpenPreview(m.approvalId);
  };

  const statusClass =
    m.status === 'approved' ? 'approval-card--approved'
    : m.status === 'denied' ? 'approval-card--denied'
    : m.status === 'expired' ? 'approval-card--expired'
    : '';

  return (
    <div
      className={`approval-card ${statusClass}`.trim()}
      data-authority={m.authority}
      data-status={m.status}
    >
      <div className="approval-card__head">
        {m.status === 'approved' ? (
          <ShieldCheck size={15} strokeWidth={2} aria-hidden="true" />
        ) : m.status === 'denied' || m.status === 'expired' ? (
          <ShieldX size={15} strokeWidth={2} aria-hidden="true" />
        ) : (
          <ShieldAlert size={15} strokeWidth={2} aria-hidden="true" />
        )}
        <span className="approval-card__title">
          {m.authority === 'code' ? '需要审批' : '需要审批'} ·{' '}
          {meta.primary || typeLabel(m.type)}
        </span>
        <span className="approval-card__state">
          {m.status === 'approved'
            ? (m.autoApproved ? 'Auto-approved' : 'Approved')
            : m.status === 'denied'
              ? 'Denied'
              : m.status === 'expired'
                ? 'Expired'
                : 'Needs approval'}
        </span>
      </div>
      {/* P3 (spec §3.3): preview summary + "查看变更" entry.
          Clicking the body or the button MUST open the diff
          panel — it must NOT auto-approve. The button is its
          own click target so a card-level click handler can
          stay on the diff opener below. */}
      {meta.primary ? (
        <div className="approval-card__summary" role="group" aria-label="审批摘要">
          <meta.icon size={14} strokeWidth={2} aria-hidden="true" />
          <span className="approval-card__summary-target" title={meta.primary}>
            {meta.primary}
          </span>
          {meta.detail ? (
            <span className="approval-card__summary-detail">{meta.detail}</span>
          ) : null}
        </div>
      ) : null}
      {/* Computer-use visual (2026-09-03 acceptance C02–C06 UX): a stylized
          screen + action facts instead of raw args. The typed TEXT itself is
          never echoed (C06) — only its character count. Visual language
          forked from Playwright Trace Viewer's action-highlight chip. */}
      {m.preview?.kind === 'desktop' ? (
        <div className="approval-card__desktop" role="group" aria-label="桌面操作预览">
          <svg className="approval-card__desktop-screen" viewBox="0 0 64 44" aria-hidden="true">
            <rect x="1.5" y="1.5" width="61" height="34" rx="3" />
            <line x1="20" y1="42" x2="44" y2="42" />
            <circle cx="32" cy="18.5" r="6.5" />
            <line x1="32" y1="8" x2="32" y2="29" />
            <line x1="21.5" y1="18.5" x2="42.5" y2="18.5" />
          </svg>
          <div className="approval-card__desktop-facts">
            <span className="approval-card__desktop-action">
              {m.preview.actionLabel ?? m.preview.title}
            </span>
            {m.preview.target ? (
              <span className="approval-card__desktop-target">{m.preview.target}</span>
            ) : null}
            {m.preview.textChars !== undefined ? (
              <span className="approval-card__desktop-mask">
                键入 {m.preview.textChars} 个字符 · 内容已隐藏
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="approval-card__body">{m.description}</p>
      {resolved ? null : (
        <div className="approval-card__actions">
          <button
            type="button"
            className="approval-card__btn approval-card__btn--preview"
            onClick={openPreview}
            disabled={!props.onOpenPreview || m.preview?.kind !== 'diff'}
            title={m.preview?.kind === 'diff' ? '查看变更' : '无可预览的变更'}
            aria-label="查看变更"
          >
            <Eye size={13} strokeWidth={2} aria-hidden="true" />
            <span>查看变更</span>
          </button>
          <div className="approval-card__actions-spacer" aria-hidden="true" />
          <button
            type="button"
            className="approval-card__btn approval-card__btn--deny"
            onClick={() => respond(false)}
            disabled={submitting || !props.onRespond}
          >
            拒绝
          </button>
          <button
            type="button"
            className="approval-card__btn approval-card__btn--approve"
            onClick={() => respond(true)}
            disabled={submitting || !props.onRespond}
          >
            批准并继续
          </button>
        </div>
      )}
    </div>
  );
}
