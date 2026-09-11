// Trylo Desktop — applyCompact + applyCompactionTrigger
// reducer test. See v1.16.0.
//
// events.test.ts has pre-existing fixture-driven
// failures (the user said: don't fix). This file
// covers the two new compaction cases in isolation.

import { describe, expect, it } from 'vitest';
import { applyEvents } from './events';
import type {
  CompactionTriggerEvent,
  CompactEvent,
} from '../../host-adapter/loop-events';

function makeTrigger(over: Partial<CompactionTriggerEvent> = {}): CompactionTriggerEvent {
  return {
    type: 'compaction_trigger',
    seq: 1,
    ts: 1000,
    trigger: 'manual',
    preTokens: 180_000,
    postTokens: 40_000,
    ...over,
  };
}

function makeCompact(over: Partial<CompactEvent> = {}): CompactEvent {
  return {
    type: 'compact',
    seq: 2,
    ts: 2000,
    kind: 'after',
    tokensBefore: 180_000,
    tokensAfter: 40_000,
    reason: 'manual',
    ...over,
  };
}

describe('applyCompactionTrigger (v1.16.0)', () => {
  it('appends a pending "Compacting…" notice', () => {
    const out = applyEvents([], [makeTrigger()]);
    const last = out[out.length - 1];
    expect(last).toBeDefined();
    if (last && last.kind === 'notice') {
      expect(last.text).toMatch(/^Compacting context \(180k → 40k\)/);
    } else {
      throw new Error('expected a notice message');
    }
  });

  it('shows the pre/post token counts in the pending text', () => {
    const out = applyEvents([], [makeTrigger({ preTokens: 47_000, postTokens: 12_000 })]);
    const last = out[out.length - 1];
    if (last && last.kind === 'notice') {
      expect(last.text).toContain('47k');
      expect(last.text).toContain('12k');
    }
  });
});

describe('applyCompact (v1.16.0)', () => {
  it('replaces a pending notice with a CompactionMessage', () => {
    const triggered = applyEvents([], [makeTrigger()]);
    const out = applyEvents(triggered, [makeCompact()]);
    // The pending notice should be gone; a CompactionMessage
    // should take its place.
    const notices = out.filter((m) => m.kind === 'notice');
    const compactions = out.filter((m) => m.kind === 'compaction');
    expect(notices).toHaveLength(0);
    expect(compactions).toHaveLength(1);
    const c = compactions[0]!;
    // Narrow for the property accesses below.
    if (c.kind !== 'compaction') throw new Error('expected compaction');
    expect(c.tokensBefore).toBe(180_000);
    expect(c.tokensAfter).toBe(40_000);
    expect(c.reason).toBe('manual');
  });

  it('appends a CompactionMessage when there is no pending notice', () => {
    // If the CLI emits `compact` without a prior
    // `compaction_trigger` (or it was lost), we still
    // want the result pill. This shouldn't happen in
    // practice but is a safe fallback.
    const out = applyEvents([], [makeCompact()]);
    const compactions = out.filter((m) => m.kind === 'compaction');
    expect(compactions).toHaveLength(1);
  });

  it('does not touch prior messages in the conversation', () => {
    // Build a mini history then run a full compact cycle.
    const history = applyEvents([], [makeTrigger()]);
    const out = applyEvents(history, [makeCompact()]);
    // One message in, one message out: the notice is
    // replaced, no extras.
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('compaction');
  });

  it('sweeps ALL stale pending notices, not just the last one', () => {
    // If a trigger's `compact` event was lost and a later trigger re-fired,
    // the stream can hold more than one "Compacting…" notice. Put a message
    // between two triggers so the dedupe (tail-only) appends a second notice.
    const gap = applyEvents([], [
      makeTrigger({ seq: 1, ts: 1000 }),
      { type: 'text', seq: 2, ts: 1500, preview: 'hi', fullText: 'hi' } as never,
      makeTrigger({ seq: 3, ts: 1600, preTokens: 200_000, postTokens: 60_000 }),
    ]);
    const noticesBefore = gap.filter(
      (m) => m.kind === 'notice' && m.text.startsWith('Compacting context'),
    );
    expect(noticesBefore.length).toBeGreaterThanOrEqual(2);

    const out = applyEvents(gap, [makeCompact({ ts: 2000 })]);
    // Every stale notice must be gone, with exactly one pill left.
    expect(
      out.filter((m) => m.kind === 'notice' && m.text.startsWith('Compacting context')),
    ).toHaveLength(0);
    expect(out.filter((m) => m.kind === 'compaction')).toHaveLength(1);
  });
});

describe('applyCompact identical redelivery guard', () => {
  it('drops a byte-identical re-delivered compact (tail replay / CLI double-emit)', () => {
    // The user's flood: ~20 identical "168k → 3.4k" pills. A second
    // `compact` with the same numbers is the SAME compaction, not a
    // new one — the stream must not grow.
    const once = applyEvents(
      [],
      [makeCompact({ tokensBefore: 168_000, tokensAfter: 3_400, reason: 'auto', seq: 5, ts: 5000 })],
    );
    expect(once.filter((m) => m.kind === 'compaction')).toHaveLength(1);
    const twice = applyEvents(
      once,
      [makeCompact({ tokensBefore: 168_000, tokensAfter: 3_400, reason: 'auto', seq: 6, ts: 6000 })],
    );
    expect(twice.filter((m) => m.kind === 'compaction')).toHaveLength(1);
    expect(twice).toHaveLength(once.length);
  });

  it('keeps a genuine second compaction with grown numbers', () => {
    const once = applyEvents(
      [],
      [makeCompact({ tokensBefore: 168_000, tokensAfter: 3_400, reason: 'auto' })],
    );
    // Context grew again and compacted a second time: different
    // before/after → a second pill is correct.
    const twice = applyEvents(
      once,
      [makeCompact({ tokensBefore: 96_000, tokensAfter: 4_100, reason: 'auto', seq: 9, ts: 9000 })],
    );
    expect(twice.filter((m) => m.kind === 'compaction')).toHaveLength(2);
  });

  it('dedupes across interleaved tool cards (the flood shape)', () => {
    // Replay order in the wild: pill, tool, tool, pill(replay),
    // tool… — the guard scans back past unrelated cards.
    let msgs = applyEvents(
      [],
      [makeCompact({ tokensBefore: 168_000, tokensAfter: 3_400, reason: 'auto' })],
    );
    msgs = applyEvents(msgs, [
      { type: 'tool_use', seq: 6, ts: 6000, tool: 'Bash', input: {}, id: 'tool-a' } as never,
    ]);
    msgs = applyEvents(msgs, [
      makeCompact({ tokensBefore: 168_000, tokensAfter: 3_400, reason: 'auto', seq: 7, ts: 7000 }),
    ]);
    expect(msgs.filter((m) => m.kind === 'compaction')).toHaveLength(1);
  });
});
describe('applyCompactionTrigger dedupe (audit)', () => {
  it('replaces an existing pending notice instead of appending', () => {
    // Two triggers in a row (rare but possible) should
    // produce exactly one pending notice in the stream.
    const once = applyEvents([], [makeTrigger({ preTokens: 180_000 })]);
    const twice = applyEvents(once, [makeTrigger({ preTokens: 200_000, postTokens: 60_000, seq: 2 })]);
    const notices = twice.filter(
      (m) => m.kind === 'notice' && m.text.startsWith('Compacting context'),
    );
    expect(notices).toHaveLength(1);
    // The remaining notice has the LATEST pre/post
    // values (200k -> 60k).
    if (notices[0]!.kind === 'notice') {
      expect(notices[0]!.text).toContain('200k');
      expect(notices[0]!.text).toContain('60k');
    }
  });
});
