// 2026-09-04: context-ring compaction fix. `latestContextTokens` must
// honor a compaction's tokensAfter immediately — the old turn-only
// derivation left the ring stale (pre-compaction) until the NEXT
// turn_end, which is exactly the "压缩后圈不更新" bug.

import { describe, expect, it } from 'vitest';
import { latestContextTokens, type CompactionMessage, type TurnMessage } from './types';

function turn(id: string, inputTokens: number, createdAt = 1): TurnMessage {
  return {
    id,
    kind: 'turn',
    role: 'assistant',
    createdAt,
    turn: 1,
    depth: 0,
    agentId: null,
    status: 'done',
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  };
}

function compaction(id: string, before: number, after: number, createdAt = 2): CompactionMessage {
  return {
    id,
    kind: 'compaction',
    role: 'system',
    createdAt,
    reason: 'manual',
    tokensBefore: before,
    tokensAfter: after,
  };
}

describe('latestContextTokens (context-ring compaction fix)', () => {
  it('returns 0 for an empty stream', () => {
    expect(latestContextTokens([])).toBe(0);
  });

  it('returns the latest turn usage when no compaction exists', () => {
    expect(latestContextTokens([turn('t1', 47_000), turn('t2', 51_000)])).toBe(51_000);
  });

  it('drops to tokensAfter IMMEDIATELY after a compaction (the bug)', () => {
    const msgs = [turn('t1', 180_000), compaction('c1', 180_000, 40_000)];
    expect(latestContextTokens(msgs)).toBe(40_000);
  });

  it('a newer turn AFTER the compaction refreshes the number again', () => {
    const msgs = [
      turn('t1', 180_000),
      compaction('c1', 180_000, 40_000),
      turn('t2', 43_500, 3),
    ];
    expect(latestContextTokens(msgs)).toBe(43_500);
  });

  it('an OLDER compaction does not override a NEWER turn (backward walk)', () => {
    const msgs = [
      compaction('c1', 180_000, 40_000, 1),
      turn('t2', 55_000, 2),
    ];
    expect(latestContextTokens(msgs)).toBe(55_000);
  });

  it('skips messages without usage evidence (text, notices)', () => {
    const msgs = [
      { id: 'u1', kind: 'text', role: 'user', createdAt: 1, text: 'hi' },
      turn('t1', 12_000),
    ] as never[];
    expect(latestContextTokens(msgs)).toBe(12_000);
  });

  it('skips a newer turn with EMPTY usage (CLI omitted input_tokens) and keeps the last good reading', () => {
    const emptyUsageTurn: TurnMessage = {
      ...turn('t2', 0, 3),
      usage: {},
    };
    const msgs = [turn('t1', 95_000), emptyUsageTurn];
    expect(latestContextTokens(msgs)).toBe(95_000);
  });

  it('returns 0 when the only turn has no usable usage', () => {
    const msgs = [{ ...turn('t1', 0), usage: {} }];
    expect(latestContextTokens(msgs)).toBe(0);
  });
});
