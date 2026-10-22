// Trylo Desktop — ProcessHeader. See
// spike-results/phase-2-ui-redesign.md.
//
// v1.10: a compact status bar above the input bar.
// Shows the agent state (ready / running / error) and,
// when running, the turn count, the tool count, and the
// elapsed time. When idle and there are no messages, the
// workspace root is shown so the user knows which folder
// the agent will run in.
//
// v1.15: moved above InputBar (per v1.15-handoff §1.1).
//
// 2026-09-04 (CLI 单核): the Work runtime status / ControlPlane
// connection states (runtime_* — the old 「执行端启动失败」 red
// banner) are retired with the workd daemon. The header derives
// ONE `ConversationRunViewState` from the CLI supervisor inputs
// (`running` / `error` / messages) and renders a single
// label/tone/metadata row.

import { useMemo, type ReactElement } from 'react';
import { StopRunButton } from './StopRunButton';
import type { ChatMessage } from './types';
import { motionPolicyFor } from './motion-policy';
import {
  type ConversationRunViewState,
  deriveConversationRunViewState,
  viewStateLabel,
  viewStateTone,
} from './view-state';

export interface ProcessHeaderProps {
  readonly messages: readonly ChatMessage[];
  /** When the agent is currently running. */
  readonly running: boolean;
  /** When the agent is in an error state. Wins over running. */
  readonly error?: boolean;
  /**
   * Workspace root. Shown when the agent is idle AND there
   * are no messages, so the user knows what the next run
   * will operate on. Truncated to a short form.
   */
  readonly workspace?: string;
  /**
   * The already-derived visible run state. When omitted the
   * header derives it from the props above — both paths
   * share the same derivation.
   */
  readonly viewState?: ConversationRunViewState;
  /** Stop button while a run is active (running tone). */
  readonly onStop?: () => void;
}

/** Last path segment, e.g. `C:/work/demo-ws` → `trylo`. */
function basenameOf(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

/** The single status label for a view state. */
function stateLabel(state: ConversationRunViewState): string {
  // Round-3 P2: one wording per state — see viewStateLabel. The local switch
  // it replaced is gone so a new state cannot grow a second phrasing here.
  return viewStateLabel(state);
}

export function ProcessHeader(props: ProcessHeaderProps): ReactElement | null {
  const viewState = useMemo<ConversationRunViewState>(
    () =>
      props.viewState ??
      deriveConversationRunViewState({
        messages: props.messages,
        running: props.running,
        error: props.error,
      }),
    [props.viewState, props.messages, props.running, props.error],
  );

  // Turn / tools metadata (duration is shown only at the end of the turn): shown for an active
  // run with messages — both surfaces run on the CLI, so
  // the same stats language applies (spec §4.3).
  const stats = useMemo(() => {
    let turn = 0;
    let tools = 0;
    let lastTurn = 0;
    // P0-1c: the visible turn number counts USER turns. A `kind:'turn'`
    // record cannot be trusted for it — the v1 adapter stamps `turn: 1`
    // on every event it projects, so `Math.max(turn, m.turn)` pinned
    // this row at "Turn 1" forever.
    let userTurns = 0;
    for (const m of props.messages) {
      if (m.kind === 'turn') {
        turn = Math.max(turn, m.turn);
        lastTurn = m.turn;
      } else if (m.kind === 'tool') {
        tools += 1;
      } else if (m.kind === 'text' && m.role === 'user') {
        userTurns += 1;

      }
    }
    return { turn, lastTurn, tools, userTurns };
  }, [props.messages]);

  const tone = viewStateTone(viewState);
  // The Stop button shows only while a run is active AND
  // the capability supplied an onStop handler.
  const showStop = props.onStop !== undefined && tone === 'running';
  // The dot pulses only when the MotionPolicy allows it —
  // never during `thinking`, never in terminal/idle
  // states. `tone` still decides the color.
  const dotPulse = motionPolicyFor(viewState).headerPulse;
  const label = stateLabel(viewState);
  const isIdle = viewState === 'idle';
  const isEmpty = props.messages.length === 0;
  if (!isEmpty && (isIdle || viewState === 'completed' || viewState === 'cancelled')) {
    return null;
  }
  const showStats = tone === 'running' && props.messages.length > 0;

  return (
    <div
      className={`process-header${tone === 'error' ? ' process-header--error' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span
        className={`process-header__dot process-header__dot--${tone}${dotPulse ? ' process-header__dot--pulse' : ''}`}
      />
      <span className="process-header__label">{label}</span>
      {showStats ? (
        <>
          <span className="process-header__sep">·</span>
          <span>Turn {stats.userTurns}</span>
          <span className="process-header__sep">·</span>
          <span>{stats.tools} tool{stats.tools === 1 ? '' : 's'}</span>

        </>
      ) : (
        isIdle && isEmpty && props.workspace && (
          <>
            <span className="process-header__sep">·</span>
            <span className="process-header__sep-label">工作区</span>
            <span
              className="process-header__workspace"
              title={props.workspace}
            >
              {basenameOf(props.workspace)}
            </span>
          </>
        )
      )}
      {showStop && (
        <StopRunButton className="process-header__stop" onStop={props.onStop!} />
      )}
    </div>
  );
}
