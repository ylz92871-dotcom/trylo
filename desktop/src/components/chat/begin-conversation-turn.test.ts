import { describe, expect, it } from 'vitest';
import { beginConversationTurn } from './types';

describe('beginConversationTurn (spec §6.1)', () => {
  it('stamps id/turnId/createdAt/turnStartedAt so the timer starts on send', () => {
    const turn = beginConversationTurn({ text: 'hello', now: 1000 });
    // 1000 in base 36 is "rs", so the default id is "user-rs".
    expect(turn).toEqual({
      id: 'user-rs',
      turnId: 'user-rs',
      role: 'user',
      kind: 'text',
      createdAt: 1000,
      turnStartedAt: 1000,
      text: 'hello',
    });
  });

  it('uses an explicit turnId and keeps it as the message id', () => {
    const turn = beginConversationTurn({ text: 'hi', turnId: 'user-abc', now: 2000 });
    expect(turn.id).toBe('user-abc');
    expect(turn.turnId).toBe('user-abc');
    expect(turn.turnStartedAt).toBe(2000);
  });

  it('defaults now to Date.now() when omitted', () => {
    const before = Date.now();
    const turn = beginConversationTurn({ text: 'hi' });
    const after = Date.now();
    expect(turn.createdAt).toBeGreaterThanOrEqual(before);
    expect(turn.createdAt).toBeLessThanOrEqual(after);
    expect(turn.turnStartedAt).toBe(turn.createdAt);
  });

  it('lets MessageList read a real turnStartedAt (Work sends show TurnProgress)', () => {
    // Spec §11.4: "TurnProgress 在 Work 发送后立即出现". The
    // Work handleWorkSend now routes through this helper, so
    // the user message it pushes always carries the anchor.
    const turn = beginConversationTurn({ text: 'write a report', turnId: 'user-w1', now: 5000 });
    expect(turn.turnStartedAt).toBeDefined();
    expect(turn.turnId).toBe('user-w1');
  });
});
