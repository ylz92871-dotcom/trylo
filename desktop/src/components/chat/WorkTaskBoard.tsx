// Trylo Work's task surface.
//
// Work is deliverable-oriented, so it does not reuse Code's reasoning
// transcript. One run is presented as a stable task board: stage, current
// narration and factual activity. The underlying projection messages remain
// independently persisted; this component only changes their visual grammar.

import { memo, useState, type ReactElement } from 'react';
import { Check, ChevronRight, Circle, Loader, X } from 'lucide-react';
import {
  WORK_PHASE_LABELS,
  WORK_SEMANTIC_PHASES,
  type WorkPhaseState,
} from '@trylo/work';
import { WorkActivityGroup } from './WorkActivityGroup';
import type {
  WorkActivityGroupMessage,
  WorkNarrationLine,
  WorkRailMessage,
} from './types';

export interface WorkTaskBoardProps {
  readonly rail: WorkRailMessage;
  readonly narrations: readonly WorkNarrationLine[];
  readonly activity?: WorkActivityGroupMessage;
  readonly taskTitle?: string;
}

const FREEFORM_PAUSE_RE = /(?:paused\s*[-—:]?\s*)?awaiting\s+user\s+input|等待用户输入/i;
const ACTIONABLE_QUESTION_RE = /[?？]|\b(?:reply|respond|choose|confirm|enable)\b|(?:请|是否|需要).*(?:回复|选择|确认|启用|吗)/i;
const SHELL_ACCESS_RE = /shell access|enable shell|命令行权限|shell\s*(?:权限|访问)/i;

export function workPausePrompt(narrations: readonly WorkNarrationLine[]): string {
  const question = [...narrations]
    .reverse()
    .find((entry) => !FREEFORM_PAUSE_RE.test(entry.text) && ACTIONABLE_QUESTION_RE.test(entry.text));
  if (question && SHELL_ACCESS_RE.test(question.text)) {
    return '任务需要命令行权限。回复 “enable shell” 继续，或回复 “continue without shell” 以受限方式继续。';
  }
  return question?.text ?? '任务正在等待你的回复；直接在下方输入即可继续。';
}

function WorkTaskBoardImpl(props: WorkTaskBoardProps): ReactElement {
  const [showHistory, setShowHistory] = useState(false);
  const projection = props.rail.projection;
  const terminal = projection.terminal;
  // Open from the start and STAY open once the run reaches a terminal state.
  //
  // The previous behaviour collapsed the board 420ms after completion. That
  // hid the phase list and the "current" narration — i.e. exactly what the
  // run produced — behind a single "已完成 3/5" header, so a finished task
  // looked empty. The user can still collapse it manually.
  const [expanded, setExpanded] = useState(true);
  const blocker = projection.blockers[0];
  const phaseById = new Map<string, WorkPhaseState>();
  for (const phase of projection.phases) phaseById.set(phase.phase, phase);

  const latestNarration = props.narrations.at(-1);
  const awaitingFreeformInput = Boolean(
    latestNarration && FREEFORM_PAUSE_RE.test(latestNarration.text),
  );
  const latestNarrationText = latestNarration
    ? awaitingFreeformInput && !blocker
      ? workPausePrompt(props.narrations)
      : latestNarration.text
    : undefined;
  const olderNarrations = latestNarration
    ? props.narrations.filter((entry) => entry.id !== latestNarration.id)
    : [];
  const completed = projection.phases.filter(
    (phase) => phase.status === 'completed' || phase.status === 'failed',
  ).length;
  const activePhase = projection.phases.find((phase) => phase.status === 'active');
  const status = terminal?.kind === 'final_answer'
    ? '已完成'
    : terminal?.kind === 'error'
      ? '失败'
      : terminal?.kind === 'cancelled'
        ? '已取消'
        : blocker
          ? (blocker.label || '等待你的决定')
          : awaitingFreeformInput
            ? '等待回复'
          : (activePhase?.label || '准备中');
  const taskTitle = props.taskTitle?.trim() || '工作任务';

  return (
    <section
      className={`work-task-board${terminal ? ' work-task-board--terminal' : ''}${blocker ? ' work-task-board--blocked' : ''}${awaitingFreeformInput ? ' work-task-board--awaiting' : ''}`}
      role="listitem"
      aria-label={`Trylo Work · ${status}`}
    >
      <button
        type="button"
        className="work-task-board__head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="work-task-board__state" aria-hidden="true">
          {terminal?.kind === 'error'
            ? <X size={15} strokeWidth={2.3} />
            : terminal
              ? <Check size={15} strokeWidth={2.3} />
            : blocker || awaitingFreeformInput
                ? <Circle size={15} strokeWidth={2.3} />
                : <Loader size={15} strokeWidth={2.3} />}
        </span>
        <strong className="work-task-board__title">{taskTitle}</strong>
        <span className="work-task-board__meta">
          <span className="work-task-board__status">{status}</span>
          <span className="work-task-board__count">
            {completed}/{WORK_SEMANTIC_PHASES.length}
          </span>
          <ChevronRight
            size={15}
            strokeWidth={2.2}
            className={`disclosure-chevron${expanded ? ' disclosure-chevron--open' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>

      <div className={`disclosure${expanded ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
      <div className="work-task-board__body">
      <ol className="work-task-board__phases" aria-label="任务阶段">
        {WORK_SEMANTIC_PHASES.map((phaseId) => {
          const phase = phaseById.get(phaseId);
          const phaseStatus = phase?.status ?? 'pending';
          return (
            <li
              key={phaseId}
              className={`work-task-board__phase work-task-board__phase--${phaseStatus}`}
              aria-current={phaseStatus === 'active' ? 'step' : undefined}
            >
              <span className="work-task-board__phase-marker" aria-hidden="true">
                {phaseStatus === 'completed'
                  ? <Check size={11} strokeWidth={2.4} />
                  : phaseStatus === 'failed'
                    ? <X size={11} strokeWidth={2.4} />
                    : phaseStatus === 'active' && !terminal && !blocker && !awaitingFreeformInput
                      ? <Loader size={11} strokeWidth={2.4} />
                      : <Circle size={9} strokeWidth={2} />}
              </span>
              <span>{phase?.label || WORK_PHASE_LABELS[phaseId]}</span>
            </li>
          );
        })}
      </ol>

      {latestNarration && (
        <div className="work-task-board__now" aria-live="polite">
          <span className="work-task-board__now-label">当前</span>
          <p>{latestNarrationText}</p>
        </div>
      )}

      {olderNarrations.length > 0 && (
        <div className="work-task-board__history">
          <button
            type="button"
            className="work-task-board__history-toggle"
            onClick={() => setShowHistory((value) => !value)}
            aria-expanded={showHistory}
          >
            <ChevronRight
              size={13}
              className={`disclosure-chevron${showHistory ? ' disclosure-chevron--open' : ''}`}
              aria-hidden="true"
            />
            阶段记录 · {olderNarrations.length}
          </button>
          <div className={`disclosure${showHistory ? ' disclosure--open' : ''}`}>
            <div className="disclosure__inner">
              <ol className="work-task-board__history-list">
                {olderNarrations.map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.phaseId}</span>
                    <p>{entry.text}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}

      {props.activity && (
        <div className="work-task-board__activity">
          <WorkActivityGroup message={props.activity} />
          {/* Browser / Office / 电脑 hint — when the activity aggregate contains those kinds */}
          {props.activity.activities.some((a) => a.kind === 'browser' || a.kind === 'browser_debug') && (
            <div className="auto-notice auto-notice--info">
              <span className="auto-notice__title">浏览器 · 受控会话</span>
              <span className="auto-notice__detail">隔离会话 · 下载仅 .trylo/out/</span>
              <button
                type="button"
                className="auto-notice__pause"
                onClick={() => window.dispatchEvent(new CustomEvent('trylo:open-browser-preview'))}
              >
                打开预览
              </button>
            </div>
          )}
          {props.activity.activities.some((a) => a.kind === 'office') && (
            <div className="auto-notice auto-notice--info">
              <span className="auto-notice__title">Office · 受控会话</span>
              <span className="auto-notice__detail">写入仅 .trylo/out/ · 原件不受影响</span>
            </div>
          )}
          {props.activity.activities.some((a) => a.kind === 'computer_control') && (
            <div className="auto-notice auto-notice--warn">
              <span className="auto-notice__title">电脑控制 · 白名单 11 工具</span>
              <span className="auto-notice__detail">截图 1920×1080 上限 · 不持久化</span>
            </div>
          )}
        </div>
      )}
      </div>
        </div>
      </div>
    </section>
  );
}

export const WorkTaskBoard = memo(WorkTaskBoardImpl);
WorkTaskBoard.displayName = 'WorkTaskBoard';
