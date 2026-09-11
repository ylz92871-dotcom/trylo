// Trylo Desktop — WorkPhaseRail (redesign spec §4.1, §7.3).
//
// The linear task rail: one card per task-intent run that
// answers ONLY "where am I / what is done". It renders the
// five canonical semantic phases (理解 → 查找 → 执行 → 验证 →
// 交付) from the WorkTurnProjection snapshot the rail message
// carries — never from raw frames (§11.3).
//
// Honesty rules this component enforces (spec §9 / §15):
//   - exactly ONE rail per task run (the mapper upserts the
//     `rail:${runId}` message in place);
//   - a blocker parks the rail: the spinner stops and the
//     blocker label surfaces (阻塞停动画);
//   - after the terminal lands, NO spinner remains (final 后
//     spinner 消失) — the active phase freezes as a static
//     marker.

import { memo, type ReactElement } from 'react';
import { Check, Circle, Loader, X } from 'lucide-react';
import {
  WORK_SEMANTIC_PHASES,
  WORK_PHASE_LABELS,
  type WorkPhaseState,
  type WorkTurnProjection,
} from '@trylo/work';
import type { WorkRailMessage } from './types';

export interface WorkPhaseRailProps {
  readonly message: WorkRailMessage;
}

type RenderStatus = 'pending' | 'active' | 'completed' | 'failed' | 'blocked';

function phaseStatusIcon(status: RenderStatus): ReactElement {
  switch (status) {
    case 'completed':
      return <Check size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'failed':
      return <X size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'active':
      // The Loader only spins while the run is live AND not
      // blocked — the wrapper class below stops the animation
      // otherwise (spec §9 阻塞停动画).
      return <Loader size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'blocked':
      return <Circle size={12} strokeWidth={2.4} aria-hidden="true" />;
    case 'pending':
      return <Circle size={12} strokeWidth={2} aria-hidden="true" />;
  }
}

function terminalLabel(p: WorkTurnProjection): string {
  const terminal = p.terminal;
  if (!terminal) return '';
  switch (terminal.kind) {
    case 'final_answer':
      return '已完成';
    case 'error':
      return '失败';
    case 'cancelled':
      return '已取消';
  }
}

function runningLabel(p: WorkTurnProjection): string {
  switch (p.state) {
    case 'understanding':
      return '理解任务';
    case 'planning':
      return '制定计划';
    case 'executing':
      return '执行中';
    case 'verifying':
      return '验证中';
    case 'finalizing':
      return '收尾中';
    case 'recovering':
      return '恢复中';
    case 'awaiting_approval':
      return '等待授权';
    case 'awaiting_input':
      return '等待输入';
    default:
      return '进行中';
  }
}

function WorkPhaseRailImpl(props: WorkPhaseRailProps): ReactElement {
  const p = props.message.projection;
  const terminal = p.terminal !== undefined;
  const blocked = !terminal && p.blockers.length > 0;
  const failedTerminal = p.terminal?.kind === 'error';

  const byPhase = new Map<string, WorkPhaseState>();
  for (const ph of p.phases) byPhase.set(ph.phase, ph);
  const completedCount = p.phases.filter(
    (ph) => ph.status === 'completed' || ph.status === 'failed',
  ).length;

  const headLabel = terminal ? terminalLabel(p) : runningLabel(p);
  const blocker = p.blockers[0];

  return (
    <div
      className={
        'work-rail'
        + `${terminal ? ' work-rail--terminal' : ''}`
        + `${blocked ? ' work-rail--blocked' : ''}`
        + `${failedTerminal ? ' work-rail--failed' : ''}`
      }
      role="listitem"
      aria-label={`任务进度 · ${headLabel} · ${completedCount} / ${WORK_SEMANTIC_PHASES.length} 阶段`}
    >
      <div className="work-rail__head">
        <span
          className="work-rail__status"
          data-status={terminal ? (failedTerminal ? 'failed' : 'completed') : blocked ? 'blocked' : 'running'}
        >
          {terminal
            ? (failedTerminal
                ? <X size={12} strokeWidth={2.4} aria-hidden="true" />
                : <Check size={12} strokeWidth={2.4} aria-hidden="true" />)
            : phaseStatusIcon(blocked ? 'blocked' : 'active')}
        </span>
        <span className="work-rail__head-label">{headLabel}</span>
        <span className="work-rail__head-sep">·</span>
        <span className="work-rail__head-count">
          {`${completedCount} / ${WORK_SEMANTIC_PHASES.length} 阶段`}
        </span>
      </div>
      {blocked && blocker && (
        <div className="work-rail__blocker" role="status">
          {blocker.label || (blocker.kind === 'approval' ? '等待授权' : '等待输入')}
        </div>
      )}
      <ol className="work-rail__phases" aria-label="阶段进度">
        {WORK_SEMANTIC_PHASES.map((phase) => {
          const st = byPhase.get(phase);
          let status: RenderStatus = st?.status ?? 'pending';
          // Spec §3.3 terminal freeze: after the terminal the
          // spinner is gone — an active phase freezes as a
          // static marker (blocked look, no animation).
          if (terminal && status === 'active') status = 'blocked';
          if (blocked && status === 'active') status = 'blocked';
          const isActive = status === 'active';
          const meta = st && st.activityCount > 0 ? `${st.activityCount} 活动` : undefined;
          return (
            <li
              key={phase}
              className={`work-rail__phase work-rail__phase--${status}`}
              aria-current={isActive ? 'step' : undefined}
            >
              <span className={`work-rail__phase-icon work-rail__phase-icon--${status}`}>
                {phaseStatusIcon(status)}
              </span>
              <span className="work-rail__phase-title">
                {st?.label || WORK_PHASE_LABELS[phase]}
              </span>
              {meta !== undefined && (
                <span className="work-rail__phase-meta">{meta}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export const WorkPhaseRail = memo(WorkPhaseRailImpl);
