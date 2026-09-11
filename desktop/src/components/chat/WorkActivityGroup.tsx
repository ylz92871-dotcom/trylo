// Trylo Desktop — WorkActivityGroup (redesign spec §4.2, §4.4,
// §6.1).
//
// The collapsed activity aggregate of one task run. Instead of
// spamming the chat with one card per tool call, the linear UI
// folds every real activity fact into ONE row ("读取 6 个文件 ·
// 搜索 2 次 · 修改 3 个文件"). Expanding lists the facts —
// collapsed is the DEFAULT (spec §4.2 活动默认折叠).

import { memo, useState, type ReactElement } from 'react';
import { Check, ChevronRight, Circle, Loader, X } from 'lucide-react';
import type { WorkActivity, WorkActivityKind } from '@trylo/work';
import type { WorkActivityGroupMessage } from './types';

export interface WorkActivityGroupProps {
  readonly message: WorkActivityGroupMessage;
}

/** Compact Chinese label per activity kind (spec §6.1). */
const KIND_LABELS: Readonly<Record<WorkActivityKind, string>> = {
  file_read: '读取',
  file_write: '写入',
  file_edit: '修改',
  file_delete: '删除',
  code_search: '搜索',
  web_search: '联网搜索',
  command: '命令',
  browser: '浏览器',
  browser_debug: '浏览器调试',
  office: 'Office',
  computer_control: '电脑控制',
  cad_eda: 'CAD/EDA',
  agent: '子代理',
  verification: '验证',
  artifact: '产物',
  memory: '记忆',
  other: '操作',
};

/** Group kinds into the summary buckets the spec mockup shows. */
const SUMMARY_ORDER: readonly WorkActivityKind[] = [
  'file_read', 'code_search', 'web_search', 'file_edit', 'file_write',
  'command', 'verification', 'artifact',
];

function statusIcon(activity: WorkActivity): ReactElement {
  switch (activity.status) {
    case 'completed':
      return <Check size={11} strokeWidth={2.4} aria-hidden="true" />;
    case 'failed':
      return <X size={11} strokeWidth={2.4} aria-hidden="true" />;
    case 'blocked':
      return <Circle size={11} strokeWidth={2.4} aria-hidden="true" />;
    case 'running':
      return <Loader size={11} strokeWidth={2.4} aria-hidden="true" />;
  }
}

/** The collapsed summary: per-kind counts, batch-aware ("读取
 *  6 个文件" counts the merged batch, not the row). */
function summaryText(activities: readonly WorkActivity[]): string {
  const counts = new Map<WorkActivityKind, number>();
  for (const a of activities) {
    counts.set(a.kind, (counts.get(a.kind) ?? 0) + Math.max(1, a.batch ?? 1));
  }
  const parts: string[] = [];
  for (const kind of SUMMARY_ORDER) {
    const n = counts.get(kind);
    if (n !== undefined && n > 0) parts.push(`${KIND_LABELS[kind]} ${n}`);
  }
  for (const [kind, n] of counts) {
    if (!SUMMARY_ORDER.includes(kind) && n > 0) {
      parts.push(`${KIND_LABELS[kind]} ${n}`);
    }
  }
  return parts.join(' · ');
}

function WorkActivityGroupImpl(props: WorkActivityGroupProps): ReactElement {
  const activities = props.message.activities;
  // Spec §4.2: collapsed by default.
  const [expanded, setExpanded] = useState(false);
  const running = activities.some((a) => a.status === 'running');

  return (
    <div
      className={`work-activities${running ? ' work-activities--live' : ''}`}
      role="listitem"
      aria-label={`活动 · ${activities.length} 项`}
    >
      <button
        type="button"
        className="work-activities__head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="work-activities__head-status" aria-hidden="true">
          {running
            ? <Loader size={11} strokeWidth={2.4} />
            : <Check size={11} strokeWidth={2.4} />}
        </span>
        <span className="work-activities__head-summary">
          {summaryText(activities)}
        </span>
        <ChevronRight
          size={12}
          strokeWidth={2.4}
          className={`disclosure-chevron work-activities__chevron${expanded ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        />
      </button>
      <div className={`disclosure${expanded ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          <ul className="work-activities__list">
            {activities.map((a) => (
              <li
                key={a.id}
                className={`work-activities__row work-activities__row--${a.status}`}
              >
                <span className="work-activities__row-status" aria-hidden="true">
                  {statusIcon(a)}
                </span>
                <span className="work-activities__row-kind">
                  {KIND_LABELS[a.kind]}
                </span>
                <span className="work-activities__row-label">{a.summary}</span>
                {a.evidence.map((e) => (
                  <span key={e.label} className="work-activities__row-evidence">
                    {e.label}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export const WorkActivityGroup = memo(WorkActivityGroupImpl);
