import { describe, expect, it } from 'vitest';
import { memoryRuntime } from './hardening-fixtures';

describe('UL-P1-09 scoped cognition sessions', () => {
  it('answering from Project B does not consume Project A open cognition', async () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    const sessionA = runtime.startCognition({
      id: 'q_a',
      dimension: 'verification_audit',
      trigger: 'user_opened',
      prompt: '普通 UI 要不要减少重复审核？',
      scopeHint: 'alpha',
    }, 'D:/proj-alpha');
    expect(sessionA.status).toBe('open');

    const fromB = await runtime.handleCognitionTurn('普通功能直接做就行', 'D:/proj-beta');
    expect(fromB.answeredSessionId).not.toBe(sessionA.id);
    const stillOpen = runtime.snapshot().cognitionSessions.find((item) => item.id === sessionA.id);
    expect(stillOpen?.status).toBe('open');
  });

  it('correction governance is not inferred from 理解错/改成 keywords', () => {
    const runtime = memoryRuntime();
    const session = runtime.startCognition({
      id: 'q',
      dimension: 'verification_audit',
      trigger: 'high_value_gap',
      prompt: '验证偏好？',
      scopeHint: 'v',
    }, 'D:/proj-alpha');
    runtime.answerCognition(session.id, '你理解错了，改成普通 UI 少审核');
    const evidence = runtime.snapshot().evidence.filter((item) => item.source.sessionId === session.id);
    expect(evidence.every((item) => item.origin.eventType !== 'authoritative_correction')).toBe(true);
    expect(evidence.every((item) => item.governance.level < 4)).toBe(true);
  });
});
