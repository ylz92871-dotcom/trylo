import { describe, expect, it } from 'vitest';
import { compactTraceForLearning } from './skills';
import type { LearningInferenceSettings, UserDecisionTrace } from './types';

const settings = (allowExecutionContext: boolean): LearningInferenceSettings => ({
  enabled: true,
  mode: 'assisted',
  allowExecutionContext,
  maxCallsPerHour: 12,
  maxCallsPerTrace: 1,
});

const trace: UserDecisionTrace = {
  id: 'trace',
  userId: 'user',
  sessionId: 'session',
  taskId: 'task',
  turnId: 'turn',
  workspaceId: 'C:\\Users\\alice\\private-project',
  projectId: 'C:\\Users\\alice\\private-project',
  product: 'code',
  initialRequest: '检查 C:\\Users\\alice\\private-project\\a.ts，token_abcdefghijk 不要泄露',
  agentDecisions: [],
  userEvents: [{
    id: 'event', at: 1, actor: 'user', type: 'user_message', stage: 'task_context',
    text: '先说结论，文件在 C:\\Users\\alice\\secret.txt',
  }],
  executionResult: 'agent output C:\\Users\\alice\\result.txt',
  outcome: 'completed',
  createdAt: 1,
  closedAt: 2,
};

describe('assisted learning payload', () => {
  it('redacts paths/secrets and omits execution context by default', () => {
    const payload = compactTraceForLearning(trace, settings(false));
    expect(payload).not.toContain('alice');
    expect(payload).not.toContain('abcdefghijk');
    expect(payload).not.toContain('execution_result');
    expect(payload).not.toContain(trace.workspaceId);
  });

  it('includes bounded, redacted execution context only when explicitly enabled', () => {
    const payload = JSON.parse(compactTraceForLearning(trace, settings(true))) as { execution_result?: string };
    expect(payload.execution_result).toContain('[REDACTED_PATH]');
    expect(payload.execution_result).not.toContain('alice');
  });
});
