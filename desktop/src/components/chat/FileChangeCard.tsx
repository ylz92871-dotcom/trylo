// Trylo Desktop — IDE-style file change card.
//
// A dedicated surface for file-mutating tool calls (Edit / MultiEdit /
// Write / NotebookEdit), modelled on a mature IDE's source-control view:
//   - header: file icon + project name + workspace-relative path
//   - green "+N" additions badge, red "-N" deletions badge
//   - running/done status (same vocabulary as ToolCard)
//   - expandable body: line-level unified diff
//
// Non-file tools still render through ToolCard.

import { useState, type ReactElement } from 'react';
import {
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  FilePlus2,
  FilePenLine,
  FileMinus2,
  type LucideIcon,
} from 'lucide-react';

import type { ToolMessage } from './types';
import { toolEventStatus, toolEventVerb } from './tool-event-presentation';
import { computeFileChange, computeFileChanges, displayPathParts, type FileChange } from './file-change';

/** Cap rendered diff lines per card so a brand-new 3000-line file
 *  doesn't eat the conversation. The badges still show true totals. */
const MAX_DIFF_LINES = 120;

const STATUS_ICON: Record<ToolMessage['status'], LucideIcon> = {
  running: Loader2,
  done: CheckCircle2,
  error: XCircle,
  pending: Loader2,
  interrupted: Ban,
};

function statusLabel(s: ToolMessage['status']): string {
  if (s === 'done') return 'done';
  if (s === 'error') return 'failed';
  if (s === 'running') return 'running';
  if (s === 'interrupted') return 'interrupted';
  return 'pending';
}

const ACTIVITY_VERB: Record<string, string> = {
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
};

function pendingChangeNotice(message: ToolMessage): string | null {
  if (message.status === 'done') return null;
  if (message.status === 'error') {
    return /^(apply_patch|applypatch)$/i.test(message.tool)
      ? '修改失败；部分文件可能已写入。以下为请求内容，请结合错误结果核对。'
      : '修改失败，以下为拟修改内容。';
  }
  return message.status === 'interrupted'
    ? '修改已中断，请核对文件当前内容。' : '拟修改内容，等待工具完成。';
}

function changeVerb(change: FileChange, tool: string): string {
  if (change.operation === 'deleted') return '删除';
  if (change.operation === 'moved') return '移动';
  if (change.operation === 'overwritten') return '覆盖写入';
  if (change.isNew) return '新建';
  if (change.basis === 'result') return '修改';
  return toolEventVerb(tool);
}

export interface FileChangeCardProps {
  readonly message: ToolMessage;
  readonly change?: FileChange;
  readonly variant?: 'event';
  /** Workspace root — relativises the shown path and names the project. */
  readonly workspacePath?: string;
  readonly onOpenFile?: (path: string) => void;
}

export function FileChangeCards(props: FileChangeCardProps): ReactElement {
  const changes = computeFileChanges(props.message.tool, props.message.input, props.message.outputContent);
  return <>{changes.map((change, index) => <FileChangeCard {...props} key={`${change.path}-${index}`} change={change} />)}</>;
}

export function FileChangeCard(props: FileChangeCardProps): ReactElement | null {
  const m = props.message;
  const change = props.change ?? computeFileChange(m.tool, m.input, m.outputContent);
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (!change) return null;

  // Collapse after the edit finishes (same UX contract as ToolCard),
  // unless the user explicitly opened the card.
  const open = userOverride ?? (m.status === 'running' || (props.variant === 'event' && m.status === 'error')
    || (change.basis === 'result' && /^(Bash|PowerShell)$/i.test(m.tool)));
  const onToggle = (): void => {
    setUserOverride(!open);
  };

  const StatusIcon = STATUS_ICON[m.status];
  const Icon = change.isNew ? FilePlus2 : change.operation === 'deleted' ? FileMinus2 : FilePenLine;
  const parts = displayPathParts(change.path, props.workspacePath);
  const fileName = parts.relative.split('/').pop() ?? parts.relative;
  const dir = parts.relative.includes('/')
    ? parts.relative.slice(0, parts.relative.lastIndexOf('/'))
    : '';
  const verb = ACTIVITY_VERB[m.tool] ?? 'Editing';

  const visibleLines = showAll ? change.lines : change.lines.slice(0, MAX_DIFF_LINES);
  const hiddenCount = change.lines.length - visibleLines.length;
  const statsKnown = change.basis !== 'content';
  const caption = change.basis === 'content' ? '写入内容'
    : change.basis === 'result' ? '实际结果 · 文件行号'
      : '请求修改片段 · 行号仅作补丁或片段参考';
  const numberLabel = change.lineNumbers === 'file' ? '文件' : '片段';
  const notice = pendingChangeNotice(m);

  return (
    <div
      className={`fchange fchange--${m.status}${props.variant === 'event' ? ' fchange--event' : ''}`}
      role="listitem"
      data-testid="file-change-card"
    >
      <button
        type="button"
        className={`fchange__head${!open ? ' fchange__head--collapsed' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span
          className={`fchange__chevron disclosure-chevron${open ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        >
          <ChevronRight size={12} strokeWidth={2.4} />
        </span>
        <span className="fchange__icon" aria-hidden="true">
          <Icon size={14} strokeWidth={2.2} />
        </span>
        {props.variant === 'event' && <span className="fchange__verb">{changeVerb(change, m.tool)}</span>}
        <span className="fchange__project">{parts.project}</span>
        <span className="fchange__path" title={change.path}>
          <span className="fchange__dir">{dir ? `${dir}/` : ''}</span>
          <span className="fchange__file">{fileName}</span>
          {change.fromPath && <span className="fchange__dir">{` ← ${change.fromPath}`}</span>}
          {change.isNew && props.variant !== 'event' && <span className="fchange__newtag">new</span>}
        </span>
        {statsKnown && <span className="fchange__stats">
          <span className="fchange__add" title="Lines added">
            {change.truncated ? '≥' : ''}+{change.additions}
          </span>
          <span className="fchange__del" title="Lines removed">
            {change.truncated ? '≥' : ''}−{change.deletions}
          </span>
        </span>}
        {m.durationMs !== undefined && m.status !== 'running' && (
          <span className="fchange__time">{(m.durationMs / 1000).toFixed(1)}{props.variant === 'event' ? ' 秒' : 's'}</span>
        )}
        <span className="fchange__status">
          <StatusIcon
            size={12}
            strokeWidth={2.4}
            className={m.status === 'running' ? 'fchange__status-icon--spin' : undefined}
          />
          <span>
            {props.variant === 'event' ? toolEventStatus(m.status) : m.status === 'running' ? `${verb}…` : statusLabel(m.status)}
          </span>
        </span>
      </button>
      <div className={`disclosure${open ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          <div className="fchange__body">
            {notice && <div className="fchange__notice">{notice}</div>}
            {m.status === 'error' && (m.outputError || m.outputText) && <pre className="fchange__error" role="alert">{m.outputError || m.outputText}</pre>}
            {props.variant === 'event' && <div className="fchange__diff-header"><span>{parts.relative}</span>{statsKnown && <span className="fchange__stats"><span className="fchange__add">{change.truncated ? '≥' : ''}+{change.additions}</span><span className="fchange__del">{change.truncated ? '≥' : ''}−{change.deletions}</span></span>}</div>}
            <div className="fchange__diff-caption">{caption}{change.truncated ? ' · 部分 diff，统计仅含已提供片段' : ''}</div>
            {change.note && <div className="fchange__notice">{change.note}</div>}
            <div className="fchange__diff">
              {visibleLines.map((line, i) => (
                <div
                  key={i}
                  className={`fchange__diff-line fchange__diff-line--${line.kind}`}
                >
                  {props.variant === 'event' && <><span className="fchange__line-number" aria-label={`原${numberLabel}行号`}>{line.oldNo}</span><span className="fchange__line-number" aria-label={`新${numberLabel}行号`}>{line.newNo}</span></>}
                  <span className="fchange__diff-gutter">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="fchange__diff-text">{line.text || ' '}</span>
                </div>
              ))}
              {hiddenCount > 0 && (
                <button type="button" className="fchange__diff-more" onClick={() => setShowAll(true)}>显示剩余 {hiddenCount} 行</button>
              )}
            </div>
            {props.onOpenFile && change.operation !== 'deleted' && <button type="button" className="fchange__open" onClick={() => props.onOpenFile?.(change.path)}>打开文件</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
