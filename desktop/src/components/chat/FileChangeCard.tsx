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
  type LucideIcon,
} from 'lucide-react';

import type { ToolMessage } from './types';
import { computeFileChange, displayPathParts } from './file-change';

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

export interface FileChangeCardProps {
  readonly message: ToolMessage;
  /** Workspace root — relativises the shown path and names the project. */
  readonly workspacePath?: string;
}

export function FileChangeCard(props: FileChangeCardProps): ReactElement | null {
  const m = props.message;
  const change = computeFileChange(m.tool, m.input);
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  if (!change) return null;

  // Collapse after the edit finishes (same UX contract as ToolCard),
  // unless the user explicitly opened the card.
  const open = userOverride ?? (m.status === 'running');
  const onToggle = (): void => {
    setUserOverride((prev) =>
      prev === null ? !(m.status === 'running') : !prev,
    );
  };

  const StatusIcon = STATUS_ICON[m.status];
  const Icon = change.isNew ? FilePlus2 : FilePenLine;
  const parts = displayPathParts(change.path, props.workspacePath);
  const fileName = parts.relative.split('/').pop() ?? parts.relative;
  const dir = parts.relative.includes('/')
    ? parts.relative.slice(0, parts.relative.lastIndexOf('/'))
    : '';
  const verb = ACTIVITY_VERB[m.tool] ?? 'Editing';

  const visibleLines = change.lines.slice(0, MAX_DIFF_LINES);
  const hiddenCount = change.lines.length - visibleLines.length;

  return (
    <div
      className={`fchange fchange--${m.status}`}
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
        <span className="fchange__project">{parts.project}</span>
        <span className="fchange__path" title={change.path}>
          <span className="fchange__dir">{dir ? `${dir}/` : ''}</span>
          <span className="fchange__file">{fileName}</span>
          {change.isNew && <span className="fchange__newtag">new</span>}
        </span>
        <span className="fchange__stats">
          <span className="fchange__add" title="Lines added">
            +{change.additions}
          </span>
          <span className="fchange__del" title="Lines removed">
            −{change.deletions}
          </span>
        </span>
        {m.durationMs !== undefined && m.status !== 'running' && (
          <span className="fchange__time">{(m.durationMs / 1000).toFixed(1)}s</span>
        )}
        <span className="fchange__status">
          <StatusIcon
            size={12}
            strokeWidth={2.4}
            className={m.status === 'running' ? 'fchange__status-icon--spin' : undefined}
          />
          <span>
            {m.status === 'running' ? `${verb}…` : statusLabel(m.status)}
          </span>
        </span>
      </button>
      <div className={`disclosure${open ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          <div className="fchange__body">
            <div className="fchange__diff">
              {visibleLines.map((line, i) => (
                <div
                  key={i}
                  className={`fchange__diff-line fchange__diff-line--${line.kind}`}
                >
                  <span className="fchange__diff-gutter">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="fchange__diff-text">{line.text || ' '}</span>
                </div>
              ))}
              {hiddenCount > 0 && (
                <div className="fchange__diff-more">
                  … {hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
