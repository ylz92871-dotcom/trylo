// Trylo Desktop — applyTurnEnd reducer test. See v1.16.0.
//
// This file covers the reducer case added in v1.16.0 in
// isolation so turn-end behavior stays regression-tested.

import { describe, expect, it } from 'vitest';
import { applyEvents } from './events';
import type { TurnEndEvent } from '../../host-adapter/loop-events';

function makeTurnEnd(over: Partial<TurnEndEvent> = {}): TurnEndEvent {
  return {
    type: 'turn_end',
    seq: 1,
    ts: 1000,
    turn: 1,
    stopReason: 'end_turn',
    usage: { input_tokens: 1234, output_tokens: 56 },
    ...over,
  };
}

describe('applyTurnEnd (v1.16.0)', () => {
  it('creates a TurnMessage when none exists for the turn', () => {
    const out = applyEvents([], [makeTurnEnd({ turn: 1 })]);
    const turns = out.filter((m) => m.kind === 'turn');
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.kind).toBe('turn');
    if (t.kind === 'turn') {
      expect(t.turn).toBe(1);
      expect(t.status).toBe('done');
      expect(t.stopReason).toBe('end_turn');
      expect(t.usage).toEqual({ input_tokens: 1234, output_tokens: 56 });
    }
  });

  it('maps stopReason=max_tokens to status=error', () => {
    const out = applyEvents([], [
      makeTurnEnd({ turn: 1, stopReason: 'max_tokens' }),
    ]);
    const t = out.find((m) => m.kind === 'turn');
    if (t && t.kind === 'turn') {
      expect(t.status).toBe('error');
      expect(t.stopReason).toBe('max_tokens');
    } else {
      throw new Error('expected turn message');
    }
  });

  it('maps stopReason=tool_use to status=done (LLM called tools, normal)', () => {
    const out = applyEvents([], [
      makeTurnEnd({ turn: 1, stopReason: 'tool_use' }),
    ]);
    const t = out.find((m) => m.kind === 'turn');
    if (t && t.kind === 'turn') {
      expect(t.status).toBe('done');
    }
  });

  it('creates separate TurnMessages for distinct turn numbers', () => {
    const out = applyEvents(
      [],
      [
        makeTurnEnd({ turn: 1, usage: { input_tokens: 100, output_tokens: 5 } }),
        makeTurnEnd({ turn: 2, usage: { input_tokens: 200, output_tokens: 10 }, seq: 2, ts: 2000 }),
        makeTurnEnd({ turn: 3, usage: { input_tokens: 300, output_tokens: 15 }, seq: 3, ts: 3000 }),
      ],
    );
    const turns = out.filter((m) => m.kind === 'turn');
    expect(turns).toHaveLength(3);
  });

  it('appends to the end of the message list (chronological order)', () => {
    // Pretend there's already a user message and a thinking
    // message in the list; the new TurnMessage should land
    // after them.
    const prior: import('./types').ChatMessage[] = [
      {
        id: 'u1', kind: 'text', role: 'user', createdAt: 100, text: 'hi',
      },
      {
        id: 't1', kind: 'thinking', role: 'assistant', createdAt: 200,
        summary: 's', preview: 'p', fullLength: 1, partial: false, turn: 1,
      },
    ];
    const out = applyEvents(prior, [makeTurnEnd({ turn: 1 })]);
    expect(out).toHaveLength(3);
    expect(out[2]!.kind).toBe('turn');
  });

  it('preserves prior message order when adding the TurnMessage', () => {
    const prior: import('./types').ChatMessage[] = [
      { id: 'u1', kind: 'text', role: 'user', createdAt: 100, text: 'hi' },
    ];
    const out = applyEvents(prior, [makeTurnEnd({ turn: 1 })]);
    // First message is still the user bubble.
    expect(out[0]!.id).toBe('u1');
  });

  it('does NOT overwrite a good usage reading with an empty turn_end (ring freeze guard)', () => {
    const out = applyEvents(
      [],
      [
        makeTurnEnd({ turn: 1, usage: { input_tokens: 95_000, output_tokens: 10 } }),
        // Same turn re-emitted without usage (CLI omitted input_tokens).
        makeTurnEnd({ turn: 1, usage: {}, seq: 2, ts: 2000 }),
      ],
    );
    const t = out.find((m) => m.kind === 'turn');
    if (t && t.kind === 'turn') {
      expect(t.usage?.input_tokens).toBe(95_000);
    } else {
      throw new Error('expected turn message');
    }
  });
});
