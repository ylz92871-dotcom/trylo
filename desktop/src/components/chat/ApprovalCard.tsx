// Presentation of the owner's parsed preview; decisions return to its registry.
// Retired authorities and settled requests stay readable without decision actions.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { ArrowRight, ChevronDown, Eye, FileText, Folder, Globe, Monitor, ShieldAlert, ShieldCheck, ShieldX, Terminal, Users } from 'lucide-react';
import type { ApprovalMessage } from './types';
import type { ApprovalPreview, ApprovalDiffPreview } from '../../approval/approval-preview';

export interface ApprovalCardProps {
  readonly message: ApprovalMessage;
  readonly onRespond?: (id: string, approved: boolean) => void | boolean | 'expired' | Promise<void | boolean | 'expired'>;
  readonly onOpenPreview?: (id: string) => void;
}

const TYPE_LABELS: Readonly<Record<string, string>> = {
  'expert_library.create': '创建专家', 'expert_library.retain': '长期保存专家',
  'expert_library.edit': '修改专家配置', 'expert_library.archive': '归档专家',
  tool_library_acquire: '申请工具能力',
  run_command: '运行命令', run_shell: '运行命令', Bash: '运行命令',
  write_file: '写入文件', edit_file: '编辑文件', read_file: '读取文件',
  Write: '编辑文件', Edit: '编辑文件', MultiEdit: '编辑文件',
  web_search: '搜索网页', http_request: '外部请求', WebFetch: '访问网页', WebSearch: '搜索网页',
};

function formatDiffStats(diff: ApprovalDiffPreview | undefined): string {
  if (!diff) return '';
  const parts: string[] = [];
  if (typeof diff.additions === 'number') parts.push(`+${diff.additions}`);
  if (typeof diff.deletions === 'number') parts.push(`−${diff.deletions}`);
  return parts.join('  ');
}

function previewMeta(preview: ApprovalPreview | undefined): { icon: typeof Eye; primary: string; detail: string } {
  if (!preview) return { icon: ShieldAlert, primary: '', detail: '' };
  switch (preview.kind) {
    case 'diff': return { icon: FileText, primary: preview.target ?? preview.title, detail: formatDiffStats(preview.diff) };
    case 'command': return { icon: Terminal, primary: preview.command ?? preview.title, detail: '' };
    case 'network': return { icon: Globe, primary: preview.target ?? preview.title, detail: '' };
    case 'desktop': return { icon: Monitor, primary: preview.actionLabel ?? preview.title, detail: preview.reason ?? '' };
    case 'summary': return { icon: FileText, primary: preview.target ?? preview.title, detail: preview.reason ?? '' };
    case 'unavailable': return { icon: Eye, primary: preview.target ?? preview.title, detail: preview.reason ?? '此请求未提供可预览补丁' };
  }
}

export function ApprovalCard(props: ApprovalCardProps): ReactElement {
  const m = props.message;
  const [submitting, setSubmitting] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'denied' | 'expired' | null>(null);
  const [error, setError] = useState('');
  const [pressedBtn, setPressedBtn] = useState<'approve' | 'deny' | null>(null);
  const [justResolved, setJustResolved] = useState(false);
  const retired = m.authority !== 'code';
  const currentStatus = m.status === 'pending' ? decision ?? m.status : m.status;
  const resolved = currentStatus !== 'pending' || retired;
  const wasResolvedRef = useRef(resolved);

  useEffect(() => {
    if (!wasResolvedRef.current && resolved) {
      setJustResolved(true);
      const timer = window.setTimeout(() => setJustResolved(false), 260);
      wasResolvedRef.current = resolved;
      return () => window.clearTimeout(timer);
    }
    wasResolvedRef.current = resolved;
    return undefined;
  }, [resolved]);

  const handlePressStart = (kind: 'approve' | 'deny', event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || submitting || !props.onRespond) return;
    setPressedBtn(kind);
  };

  const handlePressMove = (kind: 'approve' | 'deny', event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (pressedBtn !== kind) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left - 4 &&
      event.clientX <= rect.right + 4 &&
      event.clientY >= rect.top - 4 &&
      event.clientY <= rect.bottom + 4;
    if (!inside) setPressedBtn(null);
  };
  const meta = previewMeta(m.preview);
  const title = m.preview?.title || (m.type ? TYPE_LABELS[m.type] ?? m.type : '权限请求');
  const status = currentStatus === 'approved' ? (m.autoApproved ? '已自动批准' : '已批准')
    : currentStatus === 'denied' ? '已拒绝' : currentStatus === 'expired' ? '已失效'
    : retired ? '执行器已退役' : '等待确认';
  const statusClass = currentStatus === 'approved' ? 'approval-card--approved'
    : currentStatus === 'denied' ? 'approval-card--denied'
    : currentStatus === 'expired' || retired ? 'approval-card--expired' : '';
  const Icon = currentStatus === 'approved' ? ShieldCheck : resolved ? ShieldX : ShieldAlert;
  // The generated tool-name caption adds no context once the complete command is visible.
  const description = m.preview?.kind === 'command' && m.preview.command && m.type && m.description.trim() === `${m.type} 请求审批`
    ? '' : m.description;

  const respond = async (approved: boolean): Promise<void> => {
    if (!props.onRespond || resolved || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const accepted = await props.onRespond(m.approvalId, approved);
      if (accepted === 'expired') setDecision('expired');
      else if (accepted === false) setError('审批未送达，决定尚未生效，请重试。');
      else if (accepted === true) setDecision(approved ? 'approved' : 'denied');
    } catch {
      setError('审批提交失败，决定尚未生效，请重试。');
    }
    finally { setSubmitting(false); }
  };

  const head = <>
    <span className="approval-card__seal" aria-hidden="true"><Icon size={18} strokeWidth={1.7} /></span>
    <span className="approval-card__heading">
      <span className="approval-card__eyebrow">{retired ? '历史审批' : '操作审批'}</span>
      <span className="approval-card__title">{title}</span>
    </span>
    <span className="approval-card__state">{status}</span>
    {resolved && <ChevronDown className="approval-card__history-chevron" size={15} aria-hidden="true" />}
  </>;

  const body = <div className="approval-card__content">
    {m.preview?.kind === 'command' && m.preview.cwd && <div className="approval-card__location" role="group" aria-label="工作目录">
      <Folder size={14} aria-hidden="true" /><span>工作目录</span><code>{m.preview.cwd}</code>
    </div>}
    {meta.primary && m.preview?.kind !== 'command' && m.preview?.kind !== 'desktop' && <div className="approval-card__summary" role="group" aria-label="审批摘要">
      <meta.icon size={15} strokeWidth={1.7} aria-hidden="true" />
      <span className="approval-card__summary-target" title={meta.primary}>{meta.primary}</span>
      {meta.detail && <span className="approval-card__summary-detail">{meta.detail}</span>}
    </div>}
    {m.preview?.kind === 'command' && m.preview.command && <details className="approval-card__command" open>
      <summary><Terminal size={13} aria-hidden="true" /><span>完整命令与执行选项</span><ChevronDown size={13} aria-hidden="true" /></summary>
      <pre><code>{m.preview.command}</code></pre>
      {m.preview.reason && <div className="approval-card__options"><span>执行选项</span><p>{m.preview.reason}</p></div>}
    </details>}
    {m.preview?.kind === 'desktop' && <div className="approval-card__desktop" role="group" aria-label="桌面操作预览">
      <svg className="approval-card__desktop-screen" viewBox="0 0 64 44" aria-hidden="true">
        <rect x="1.5" y="1.5" width="61" height="34" rx="3" />
        <line x1="20" y1="42" x2="44" y2="42" /><circle cx="32" cy="18.5" r="6.5" />
        <line x1="32" y1="8" x2="32" y2="29" /><line x1="21.5" y1="18.5" x2="42.5" y2="18.5" />
      </svg>
      <div className="approval-card__desktop-facts">
        <span className="approval-card__desktop-action">{m.preview.actionLabel ?? m.preview.title}</span>
        {m.preview.target && <span className="approval-card__desktop-target">{m.preview.target}</span>}
        {m.preview.textChars !== undefined && <span className="approval-card__desktop-mask">键入 {m.preview.textChars} 个字符 · 内容已隐藏</span>}
      </div>
    </div>}
    {m.requester && <p className="approval-card__requester" aria-label="申请成员"><Users size={13} aria-hidden="true" /><span>申请成员：{m.requester.displayName}</span></p>}
    {description && <p className="approval-card__body">{description}</p>}
  </div>;

  const attributes = {
    'data-authority': m.authority,
    'data-status': currentStatus,
    ...(justResolved ? { 'data-just-resolved': 'true' } : {}),
    'aria-label': `${retired ? '历史审批' : '操作审批'}：${title}`,
  };
  if (resolved) return <details className={`approval-card approval-card--resolved ${statusClass}`} {...attributes}>
    <summary className="approval-card__head">{head}</summary>{body}
  </details>;
  return <div className="approval-card" {...attributes}>
    <div className="approval-card__head">{head}</div>{body}
    {error && <p className="approval-card__body" role="alert">{error}</p>}
    <div className="approval-card__actions">
      {m.preview?.kind === 'diff' && <button type="button" className="approval-card__btn approval-card__btn--preview"
        onClick={() => props.onOpenPreview?.(m.approvalId)} disabled={!props.onOpenPreview} aria-label="查看变更">
        <Eye size={14} aria-hidden="true" />查看变更
      </button>}
      <div className="approval-card__decisions">
        <button
          type="button"
          className="approval-card__btn approval-card__btn--deny"
          data-pressed={pressedBtn === 'deny' ? 'true' : undefined}
          onPointerDown={(event) => handlePressStart('deny', event)}
          onPointerMove={(event) => handlePressMove('deny', event)}
          onPointerUp={() => setPressedBtn(null)}
          onPointerCancel={() => setPressedBtn(null)}
          onPointerLeave={() => setPressedBtn(null)}
          onBlur={() => setPressedBtn(null)}
          onClick={() => respond(false)}
          disabled={submitting || !props.onRespond}
        >拒绝</button>
        <button
          type="button"
          className="approval-card__btn approval-card__btn--approve"
          data-pressed={pressedBtn === 'approve' ? 'true' : undefined}
          onPointerDown={(event) => handlePressStart('approve', event)}
          onPointerMove={(event) => handlePressMove('approve', event)}
          onPointerUp={() => setPressedBtn(null)}
          onPointerCancel={() => setPressedBtn(null)}
          onPointerLeave={() => setPressedBtn(null)}
          onBlur={() => setPressedBtn(null)}
          onClick={() => respond(true)}
          disabled={submitting || !props.onRespond}
        >
          {submitting ? '正在提交…' : '批准并继续'}<ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>;
}
