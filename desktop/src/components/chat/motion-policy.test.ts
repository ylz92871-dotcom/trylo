// Trylo Desktop — ConversationMotionPolicy tests (spec §11.3).
//
// For every ConversationRunViewState assert:
//   - which primary animation is allowed;
//   - whether the footer three-dots shows;
//   - whether the header dot pulses;
//   - whether the Tool loader spinner runs.
// The table mirrors spec §7.2 exactly — if the spec table
// changes, this file is where the two stay in lock-step.

import { describe, expect, it } from 'vitest';
import {
  motionPolicyFor,
  type ConversationMotionPolicy,
  type MotionPrimary,
} from './motion-policy';
import type { ConversationRunViewState } from './view-state';

const ALL_STATES: readonly ConversationRunViewState[] = [
  'idle',
  'preparing',
  'waiting_first_output',
  'thinking',
  'tool_running',
  'finalizing',
  'awaiting_input',
  'reconnecting',
  'completed',
  'failed',
  'cancelled',
];

/** The §7.2 table, transcribed for assertion. */
const EXPECTED: Record<
  ConversationRunViewState,
  {
    readonly primary: MotionPrimary;
    readonly headerPulse: boolean;
    readonly footerDots: boolean;
    readonly turnProgressSpin: boolean;
    readonly toolLoaderSpin: boolean;
  }
> = {
  idle: {
    primary: 'none',
    headerPulse: false,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
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
  thinking: {
    primary: 'footer_dots',
    headerPulse: true,
    footerDots: true,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
  tool_running: {
    primary: 'tool_loader',
    headerPulse: true,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: true,
  },
  finalizing: {
    primary: 'none',
    headerPulse: true,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
  awaiting_input: {
    primary: 'none',
    headerPulse: false,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
  reconnecting: {
    primary: 'header_pulse',
    headerPulse: true,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
  completed: {
    primary: 'none',
    headerPulse: false,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
  failed: {
    primary: 'none',
    headerPulse: false,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
  cancelled: {
    primary: 'none',
    headerPulse: false,
    footerDots: false,
    turnProgressSpin: false,
    toolLoaderSpin: false,
  },
};

describe('ConversationMotionPolicy (spec §7.2 / §11.3)', () => {
  it('every state matches the §7.2 table exactly', () => {
    for (const s of ALL_STATES) {
      expect(motionPolicyFor(s)).toEqual(EXPECTED[s]);
    }
  });

  it('the footer heartbeat is the startup and thinking primary', () => {
    for (const s of ALL_STATES) {
      const p = motionPolicyFor(s);
      expect(p.footerDots).toBe(p.primary === 'footer_dots');
      expect(p.footerDots).toBe(
        s === 'preparing' || s === 'waiting_first_output' || s === 'thinking',
      );
    }
  });

  it('the Tool loader is the tool_running primary only', () => {
    for (const s of ALL_STATES) {
      const p = motionPolicyFor(s);
      expect(p.toolLoaderSpin).toBe(p.primary === 'tool_loader');
      expect(p.toolLoaderSpin).toBe(s === 'tool_running');
    }
  });

  it('keeps the historical turn timer static while the bottom heartbeat is primary', () => {
    for (const s of ALL_STATES) {
      const p = motionPolicyFor(s);
      expect(p.turnProgressSpin).toBe(p.primary === 'turn_progress');
      expect(p.turnProgressSpin).toBe(false);
    }
  });

  it('terminal, idle and parked states allow no loop animation at all', () => {
    for (const s of [
      'idle',
      'awaiting_input',
      'completed',
      'failed',
      'cancelled',
    ] as const) {
      const p = motionPolicyFor(s);
      expect(p.primary).toBe('none');
      expect(p.headerPulse).toBe(false);
      expect(p.footerDots).toBe(false);
      expect(p.turnProgressSpin).toBe(false);
      expect(p.toolLoaderSpin).toBe(false);
    }
  });

  it('the header pulse is the low-salience secondary in every active phase', () => {
    // One high-salience primary per phase (footer / tool loader /
    // none) plus the fixed header heartbeat — never two primaries.
    // This is what keeps a long run visibly alive even when the
    // timeline primary scrolls out of view.
    for (const s of [
      'preparing',
      'waiting_first_output',
      'thinking',
      'tool_running',
      'finalizing',
      'reconnecting',
    ] as const) {
      expect(motionPolicyFor(s).headerPulse).toBe(true);
    }
    expect(motionPolicyFor('thinking').primary).toBe('footer_dots');
    expect(motionPolicyFor('tool_running').primary).toBe('tool_loader');
  });

  it('returns a well-formed policy object for every state (no holes)', () => {
    for (const s of ALL_STATES) {
      const p: ConversationMotionPolicy = motionPolicyFor(s);
      expect(['none', 'header_pulse', 'turn_progress', 'footer_dots', 'tool_loader']).toContain(
        p.primary,
      );
      expect(typeof p.headerPulse).toBe('boolean');
      expect(typeof p.footerDots).toBe('boolean');
      expect(typeof p.turnProgressSpin).toBe('boolean');
      expect(typeof p.toolLoaderSpin).toBe('boolean');
    }
  });
});
