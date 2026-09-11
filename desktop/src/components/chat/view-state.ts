// Trylo Desktop — ConversationRunViewState.
//
// v1.16.5+ (Code-Work workflow sync spec §5.3 / §8): the
// ONE visible run state that ProcessHeader, StreamingIndicator
// and the Composer all derive from. Components stop guessing
// from a mix of `running` and the last message — they consume
// this single projection.
//
// `deriveConversationRunViewState` is the only function that
// turns the raw capability inputs into the shared state
// language. It is pure: no React, no I/O.
//
// 2026-09-04 (CLI 单核): the workd ControlPlane inputs
// (`workStatus` / `workConnStatus` and the runtime_* cold-start
// states — the old 「执行端启动失败」 vocabulary) are retired
// with the daemon. Both surfaces run on the CLI supervisor, so
// the derivation only reads `running` / `error` / messages.

import type { ChatMessage } from './types';
import { motionPolicyFor } from './motion-policy';

/** The unified visible run state (spec §5.3). */
export type ConversationRunViewState =
  // user-turn states
  | 'idle'
  | 'preparing'
  | 'waiting_first_output'
  | 'thinking'
  | 'tool_running'
  | 'finalizing'
  | 'awaiting_input'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DeriveRunViewStateInput {
  readonly messages: readonly ChatMessage[];
  /** True while a Code CLI run is in flight. */
  readonly running: boolean;
  /** Code spawn error. */
  readonly error?: boolean;
}

/** The tail of the message stream that indicates the run is
 *  still producing output. Scans from the newest message: a
 *  still-running/pending tool wins (tool_running); otherwise
 *  a still-partial thinking card wins (thinking); a partial
 *  assistant text is the final response being produced
 *  (finalizing); an UNANSWERED approval / input request parks
 *  the run on the user (awaiting_input) — first hit from the
 *  newest message wins, so work that resumed after an approval
 *  (newer tool/thinking) correctly leaves the parked state.
 *  Nothing found → still waiting for the first meaningful output.
 *
 *  WHY the parked branch matters: without it an approval wait
 *  reads as waiting_first_output and the footer dots bounce
 *  "正在准备" while the agent is actually blocked on the user —
 *  training users to distrust the heartbeat. */
function activeRunState(messages: readonly ChatMessage[]): ConversationRunViewState {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind === 'tool') {
      if (m.status === 'running' || m.status === 'pending') return 'tool_running';
    } else if (m.kind === 'thinking') {
      if (m.partial) return 'thinking';
    } else if (m.kind === 'text' && m.role === 'assistant') {
      if (m.partial) return 'finalizing';
    } else if (m.kind === 'approval') {
      if (m.status === 'pending') return 'awaiting_input';
    } else if (m.kind === 'input_request') {
      if (m.status === 'pending') return 'awaiting_input';
    }
  }
  return 'waiting_first_output';
}

/** Single source of the visible run state (spec §5.3). */
export function deriveConversationRunViewState(
  input: DeriveRunViewStateInput,
): ConversationRunViewState {
  const { messages, running, error } = input;

  // 1. Code spawn error → failed.
  if (error === true) return 'failed';

  // 2. Code run.
  if (running) {
    return messages.length === 0 ? 'preparing' : activeRunState(messages);
  }

  return 'idle';
}

/** Header dot / status tone for a state: ready (green),
 *  running (amber pulse), error (red). */
export type ViewStateTone = 'ready' | 'running' | 'error';

export function viewStateTone(state: ConversationRunViewState): ViewStateTone {
  switch (state) {
    case 'idle':
    case 'completed':
    case 'awaiting_input':
      return 'ready';
    case 'failed':
    case 'cancelled':
      return 'error';
    default:
      return 'running';
  }
}

/** The footer is the primary for startup and thinking so a run always has a
 *  visible heartbeat at the newest point in the timeline. During tool_running
 *  the Tool loader takes over. Thin convenience over `motionPolicyFor` — the
 *  MotionPolicy (b2, spec §9.1) owns the table. */
export function viewStateShowsFooterDots(state: ConversationRunViewState): boolean {
  return motionPolicyFor(state).footerDots;
}

/** Spec §7.2: the header dot pulses in every ACTIVE phase as the
 *  low-salience always-visible heartbeat (the timeline primaries
 *  can all scroll out of view). Terminal and parked states stay
 *  static. Thin convenience over `motionPolicyFor`. */
export function viewStateShowsHeaderPulse(state: ConversationRunViewState): boolean {
  return motionPolicyFor(state).headerPulse;
}
