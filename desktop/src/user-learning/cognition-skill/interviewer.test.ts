import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '../store';
import { openingMessage, isGracefulClose, nextInterviewerReply } from './interviewer';
import type { CognitionSession } from '../types';

const session = (over: Partial<CognitionSession> = {}): CognitionSession => ({
  id: 'cog_1',
  userId: 'local-user',
  trigger: 'user_opened',
  dimension: 'agent_autonomy',
  questions: [],
  answers: [],
  messages: [],
  status: 'open',
  evidenceIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('cognition interviewer', () => {
  it('opens as a conversation, not a questionnaire', () => {
    const text = openingMessage(emptySnapshot(1));
    expect(text).toMatch(/怎么跟我干活/);
    expect(text).not.toMatch(/可选/);
    expect(text).not.toMatch(/Evidence|User Model/);
    expect(text).toMatch(/报告|电脑|浏览器/);
  });

  it('treats 先这样 as a graceful close', () => {
    expect(isGracefulClose('先这样')).toBe(true);
    expect(isGracefulClose('现在不')).toBe(false);
  });

  it('asks a Work follow-up after a Code-scoped answer when Work is unknown', () => {
    const next = nextInterviewerReply({
      snapshot: emptySnapshot(1),
      session: session({ answers: [{ questionId: 'q', text: '小功能直接做', at: 1 }] }),
      lastUserText: '小功能直接做，核心先计划',
      resolution: {
        candidates: [{ claim: '用户在普通低风险任务中倾向直接执行，核心路径仍要求计划和最终验证。', scope: { scopeTags: ['ordinary'] } }],
        followUp: 'none',
        reason: 'scoped',
      },
    });
    expect(next.stop).toBe(false);
    expect(next.reply).toMatch(/记下了/);
    expect(next.reply).toMatch(/PPT|报告|电脑|浏览器|成品/);
    expect(next.reply).not.toMatch(/可选：/);
  });
});
