// Trylo Desktop — TaskHeader.
//
// v1.15.8: a persistent status row above the input that
// tells the user "agent is doing X". Borrowed from
// cline's <TaskHeader>: a small panel that shows
//   - status (idle / thinking / running tool / done / error)
//   - elapsed time
//   - current tool name (if a tool is running)
//   - workspace name
//   - stop / cancel button
//
// This is the single most important UI piece we were
// missing — without it the user has no idea what's
// happening between "send" and "first token".
//
// Phase 3: add token count + cost from api_req_finished
// events. For v1.15.8 we just show the status + timer.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Loader2, StopCircle, AlertCircle, CheckCircle2, Sparkles } from 'lucide-react';

export type TaskStatus = 'idle' | 'thinking' | 'tool' | 'done' | 'error';

export interface TaskHeaderProps {
  readonly status: TaskStatus;
  readonly workspace: string;
  /** Name of the tool currently executing (if status='tool'). */
  readonly currentTool?: string;
  /** When the active turn started (for the elapsed timer). */
  readonly turnStartedAt?: number | null;
  /** Stop button is shown when status is thinking/tool. */
  readonly onStop?: () => void;
  /** True when the underlying model is anthropic-compatible. */
  readonly hasApiKey?: boolean;
}

/** Format a millisecond duration as `0:03` / `1:24` /
 *  `1:02:33`. Matches cline's task-header style. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  idle: 'Ready',
  thinking: 'Thinking…',
  tool: 'Running tool',
  done: 'Done',
  error: 'Error',
};

export function TaskHeader(props: TaskHeaderProps): ReactElement {
  // Live-updating timer. Cline re-renders the elapsed
  // time on a setInterval; we do the same with a 1s tick
  // when a turn is active.
  const [now, setNow] = useState(() => Date.now());
  const tickRef = useRef<number | null>(null);
  useEffect(() => {
    const active = props.status === 'thinking' || props.status === 'tool';
    if (!active) {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }
    if (tickRef.current === null) {
      tickRef.current = window.setInterval(() => setNow(Date.now()), 1000);
    }
    return () => {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [props.status]);

  const start = props.turnStartedAt;
  const elapsedMs = start !== null && start !== undefined
    ? now - start
    : 0;
  const showTimer = elapsedMs > 0 && (props.status === 'thinking' || props.status === 'tool');

  return (
    <div
      className={`task-header task-header--${props.status}`}
      role="status"
      aria-live="polite"
    >
      <span className="task-header__status-pill">
        <span className="task-header__icon" aria-hidden="true">
          {props.status === 'thinking' && <Sparkles size={12} strokeWidth={2.4} />}
          {props.status === 'tool' && <Loader2 size={12} strokeWidth={2.4} className="task-header__icon--spin" />}
          {props.status === 'done' && <CheckCircle2 size={12} strokeWidth={2.4} />}
          {props.status === 'error' && <AlertCircle size={12} strokeWidth={2.4} />}
        </span>
        <span>{STATUS_LABEL[props.status]}</span>
      </span>
      {props.status === 'tool' && props.currentTool && (
        <>
          <span className="task-header__sep">·</span>
          <span className="task-header__tool">{props.currentTool}</span>
        </>
      )}
      {showTimer && (
        <>
          <span className="task-header__sep">·</span>
          <span className="task-header__timer">{formatElapsed(elapsedMs)}</span>
        </>
      )}
      <span className="task-header__sep">·</span>
      <span className="task-header__workspace" title={props.workspace}>
        {props.workspace.split(/[\\/]/).pop() || props.workspace}
      </span>
      {(props.status === 'thinking' || props.status === 'tool') && props.onStop && (
        <button
          type="button"
          className="task-header__stop"
          onClick={props.onStop}
          title="Stop the current task"
          aria-label="Stop"
        >
          <StopCircle size={14} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
