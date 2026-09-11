// Trylo Desktop — ConversationMotionPolicy.
//
// v1.16.5+ (Code-Work workflow sync spec §7.1 / §7.2): the
// ONE table that decides which loop animation may run per
// ConversationRunViewState. The spec's cardinal rule:
// "同一时刻只保留一个高显著度循环动画" — one high-salience
// primary loop per phase; every other phase is expressed
// with static color, text and one-shot transitions.
//
// Components do not guess from raw `running`/`workStatus`
// flags or message status. They call `motionPolicyFor(viewState)`
// (or the thin `view-state` helpers that delegate here) and
// render exactly the animation the policy allows.
//
// This module is deliberately table-driven and pure — no
// React, no I/O. It is the source of truth that both Code
// and Work modes share (spec §9.1).

import type { ConversationRunViewState } from './view-state';

/** The single high-salience loop animation allowed in a
 *  phase. `none` = no infinite animation; `finalizing` is
 *  a one-shot fade-in, so it also allows nothing that
 *  loops. */
export type MotionPrimary =
  | 'none'
  | 'header_pulse'
  | 'turn_progress'
  | 'footer_dots'
  | 'tool_loader';

export interface ConversationMotionPolicy {
  /** The phase's primary loop animation (§7.2). */
  readonly primary: MotionPrimary;
  /** ProcessHeader status-dot pulse. LOW salience by design (a small
   *  dot above the composer, not a bouncing widget): it is the
   *  always-visible heartbeat and stays on in EVERY active phase,
   *  including next to a timeline primary. The header is fixed on
   *  screen while timeline primaries (footer dots at list end,
   *  TurnProgress at turn top, Tool loader on its card) can all be
   *  scrolled out of view — without this, a long run shows zero
   *  motion the moment the user reads history. Terminal and parked
   *  states stay fully static. */
  readonly headerPulse: boolean;
  /** The three-dot StreamingIndicator footer (thinking). */
  readonly footerDots: boolean;
  /** The rotating TurnProgress logo (waiting_first_output). */
  readonly turnProgressSpin: boolean;
  /** The Tool status Loader spinner (tool_running). */
  readonly toolLoaderSpin: boolean;
}

const NONE: ConversationMotionPolicy = {
  primary: 'none',
  headerPulse: false,
  footerDots: false,
  turnProgressSpin: false,
  toolLoaderSpin: false,
};

/** The §7.2 table, written once. */
const POLICIES: Record<ConversationRunViewState, ConversationMotionPolicy> = {
  // No turn in flight → no loop at all.
  idle: NONE,

  // TurnProgress logo is the primary until the first
  // meaningful output lands (spec §7.2: preparing /
  // waiting_first_output). The header dot stays as a
  // low-salience pulse; footer dots and Tool pulse are off.
  preparing: {
    primary: 'footer_dots',
    headerPulse: true,
    footerDots: true,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
  waiting_first_output: {
    primary: 'footer_dots',
    headerPulse: true,
    footerDots: true,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },

  // Thinking → the footer three-dots is the single HIGH-salience
  // primary. The header dot keeps its low pulse beside it: the
  // footer lives at the list end and scrolls out of view the
  // moment the user reads history, while the header is fixed
  // above the composer. One primary, one secondary — never two
  // primaries.
  thinking: {
    primary: 'footer_dots',
    headerPulse: true,
    footerDots: true,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },

  // Tool running → the Tool status Loader is the primary.
  // Footer dots, the Tool icon rotation and the card border
  // pulse are suppressed; the header dot keeps its low
  // pulse. The ToolCard renders ONE loader (§7.2 line 359).
  tool_running: {
    primary: 'tool_loader',
    headerPulse: true,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: true,
  },

  // Final response streaming in → one-shot fade only, no
  // infinite timeline loops (spec §7.2). The header keeps its
  // low pulse: a multi-minute final answer with a frozen header
  // reads as "stuck" the moment the stream pauses between tokens.
  finalizing: {
    primary: 'none',
    headerPulse: true,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },

  // The agent is intentionally parked. The composer is the affordance; a
  // spinner would falsely imply forward progress without the user.
  awaiting_input: NONE,

  // Connection dropped mid-run → the header pulse is the
  // primary; Thinking/Tool running animations freeze
  // (spec §7.2).
  reconnecting: {
    primary: 'header_pulse',
    headerPulse: true,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },

  // Terminal states → no loop animation (spec §7.2).
  completed: NONE,
  failed: NONE,
  cancelled: NONE,
};

/** The allowed motion for a visible run state (§7.2). */
export function motionPolicyFor(
  state: ConversationRunViewState,
): ConversationMotionPolicy {
  return POLICIES[state];
}
