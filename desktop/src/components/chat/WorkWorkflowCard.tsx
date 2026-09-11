// Trylo Desktop — WorkWorkflowCard.
//
// 2026-08-29 (Work workflow UI refactor, spec §3.1): one
// card per Work run. Reuses the visual language of the
// Code-side cards (ResultDock left accent, ToolSummary
// mono chip, ThinkingCard 14px left indent, shared
// `.disclosure` expand pattern) so Work does not feel
// like a different app.
//
// Layout (matches the spec §3.1 mockup):
//
//   ┃ 任务进行中 · 2 / 4 阶段 · 01:42            ▾
//   ┃   ✓ 理解任务
//   ┃   ✓ 制定计划
//   ┃   ● 执行 ··· 正在修改 3 个文件
//   ┃     ├─ Read  src/…
//   ┃     └─ Edit  src/…  展开
//   ┃   ○ 验证
//
// Terminal state collapses to one line:
//
//   ┃ ✓ 已完成 · 4 个阶段 · 8 次工具调用 · 3 个产物   查看过程 ▸
//
// The card never duplicates tool payload — activities
// only carry a `toolMessageId` reference; the real
// ToolMessage lives elsewhere in the chat and the click
// handler can scroll the user to it.

import { memo, useState, type ReactElement } from 'react';
import { Check, ChevronRight, Circle, Loader, X } from 'lucide-react';
import type {
  WorkflowMessage,
  WorkflowPhase,
  WorkflowActivity,
} from './types';

export interface WorkWorkflowCardProps {
  readonly message: WorkflowMessage;
  /** Click on an activity that has a toolMessageId.
   *  The host decides what to do — typically scroll the
   *  chat to the underlying ToolMessage. */
  readonly onOpenActivity?: (toolMessageId: string) => void;
}

const RECENT_ACTIVITIES = 3;

function statusLabel(status: WorkflowMessage['status']): string {
  switch (status) {
    case 'running':
      return '任务进行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
  }
}

function statusIcon(status: WorkflowPhase['status']): ReactElement {
  switch (status) {
    case 'completed':
      return <Check size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'failed':
      return <X size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'active':
      return <Loader size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'cancelled':
      return <X size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'pending':
      return <Circle size={12} strokeWidth={2} aria-hidden="true" />;
  }
}

function statusIconClass(status: WorkflowPhase['status']): string {
  return `work-workflow__phase-icon work-workflow__phase-icon--${status}`;
}

function completedCount(phases: readonly WorkflowPhase[]): number {
  let n = 0;
  for (const p of phases) {
    if (p.status === 'completed' || p.status === 'failed'
        || p.status === 'cancelled') n += 1;
  }
  return n;
}

function findPhase(
  phases: readonly WorkflowPhase[],
  id: string,
): WorkflowPhase | undefined {
  return phases.find((p) => p.id === id);
}

function isPhaseExpanded(
  phase: WorkflowPhase | undefined,
  manuallyCollapsed: ReadonlySet<string>,
): boolean {
  if (!phase) return false;
  const auto = phase.status === 'active' || phase.status === 'failed';
  return auto !== manuallyCollapsed.has(phase.id);
}

function WorkWorkflowCardImpl(props: WorkWorkflowCardProps): ReactElement {
  const m = props.message;
  const terminal = m.status === 'completed' || m.status === 'failed'
    || m.status === 'cancelled';
  // A finished workflow is collapsed by default; the
  // user can expand to inspect all phases.
  const [expanded, setExpanded] = useState(!terminal);
  // Per-phase manual disclosure. Auto-expand for active /
  // failed phases; the user can override per-phase.
  const [manuallyCollapsed, setManuallyCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const togglePhase = (id: string): void => {
    setManuallyCollapsed((prev) => {
      const next = new Set(prev);
      const isCurrentlyExpanded = isPhaseExpanded(
        findPhase(m.phases, id),
        prev,
      );
      if (isCurrentlyExpanded) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <div
      className={
        `work-workflow${terminal ? ' work-workflow--terminal' : ''}`
        + `${m.status === 'failed' ? ' work-workflow--failed' : ''}`
      }
      role="listitem"
      aria-label={`${statusLabel(m.status)} · ${m.phases.length} 阶段`}
    >
      <button
        type="button"
        className="work-workflow__head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="work-workflow__status" data-status={m.status}>
          {statusIcon(
            m.status === 'running' ? 'active'
              : m.status === 'failed' ? 'failed' : 'completed',
          )}
        </span>
        <span className="work-workflow__head-label">{statusLabel(m.status)}</span>
        <span className="work-workflow__head-sep">·</span>
        <span className="work-workflow__head-count">
          {`${completedCount(m.phases)} / ${m.phases.length} 阶段`}
        </span>
        {terminal && (
          <>
            <span className="work-workflow__head-sep">·</span>
            <span className="work-workflow__head-meta">
              {`${totalActivities(m.phases)} 次工具调用`}
            </span>
          </>
        )}
        <ChevronRight
          size={12}
          strokeWidth={2.4}
          className={`disclosure-chevron work-workflow__head-chevron${expanded ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        />
      </button>
      <div className={`disclosure${expanded ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          <ol className="work-workflow__phases">
            {m.phases.map((p) => (
              <PhaseRow
                key={p.id}
                phase={p}
                manuallyCollapsed={manuallyCollapsed}
                onToggle={() => togglePhase(p.id)}
                onOpenActivity={props.onOpenActivity}
              />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function totalActivities(phases: readonly WorkflowPhase[]): number {
  let n = 0;
  for (const p of phases) n += p.activities.length;
  return n;
}

interface PhaseRowProps {
  readonly phase: WorkflowPhase;
  readonly manuallyCollapsed: ReadonlySet<string>;
  readonly onToggle: () => void;
  readonly onOpenActivity?: (toolMessageId: string) => void;
}

function PhaseRow(props: PhaseRowProps): ReactElement {
  const { phase, manuallyCollapsed, onToggle } = props;
  const isExpanded = isPhaseExpanded(phase, manuallyCollapsed);
  const recent = phase.activities.slice(-RECENT_ACTIVITIES);
  const overflow = phase.activities.length - recent.length;

  return (
    <li className={`work-workflow__phase work-workflow__phase--${phase.status}`}>
      <button
        type="button"
        className="work-workflow__phase-head"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <span className={statusIconClass(phase.status)}>
          {statusIcon(phase.status)}
        </span>
        <span className="work-workflow__phase-title">{phase.title}</span>
        {phase.activities.length > 0 && (
          <span className="work-workflow__phase-meta">
            {`${phase.activities.length} 活动`}
          </span>
        )}
      </button>
      <div className={`disclosure${isExpanded ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          {phase.activities.length > 0 && (
            <ul className="work-workflow__activities">
              {recent.map((a, i) => (
                <ActivityRow
                  key={a.id}
                  activity={a}
                  isLast={i === recent.length - 1}
                  onOpenActivity={props.onOpenActivity}
                />
              ))}
              {overflow > 0 && (
                <li className="work-workflow__activity-overflow">
                  {`展开剩余 ${overflow} 个活动`}
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

interface ActivityRowProps {
  readonly activity: WorkflowActivity;
  readonly isLast: boolean;
  readonly onOpenActivity?: (toolMessageId: string) => void;
}

function ActivityRow(props: ActivityRowProps): ReactElement {
  const { activity, isLast, onOpenActivity } = props;
  // Tree-branch character mirrors the spec §3.1 mockup
  // (`├─` / `└─`); CSS keeps the column aligned.
  const branch = isLast ? '└─' : '├─';
  const isClickable = activity.kind === 'tool' && activity.toolMessageId !== undefined;
  const onClick = isClickable && onOpenActivity
    ? () => onOpenActivity(activity.toolMessageId as string)
    : undefined;
  return (
    <li
      className={`work-workflow__activity work-workflow__activity--${activity.kind}`}
    >
      <button
        type="button"
        className={
          `work-workflow__activity-btn`
          + `${isClickable ? ' work-workflow__activity-btn--clickable' : ''}`
        }
        onClick={onClick}
        disabled={!isClickable}
        tabIndex={isClickable ? 0 : -1}
      >
        <span className="work-workflow__activity-branch" aria-hidden="true">
          {branch}
        </span>
        <span className="work-workflow__activity-kind" aria-hidden="true">
          {activity.kind}
        </span>
        <span className="work-workflow__activity-label">{activity.label}</span>
      </button>
    </li>
  );
}

export const WorkWorkflowCard = memo(WorkWorkflowCardImpl);
