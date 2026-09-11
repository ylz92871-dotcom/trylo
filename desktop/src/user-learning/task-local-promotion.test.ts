import { describe, expect, it } from 'vitest';
import { extractEvidenceFromTrace } from './evidence';
import { memoryRuntime } from './hardening-fixtures';
import type { UserDecisionTrace } from './types';

function trace(prompt: string, extra: Partial<UserDecisionTrace> = {}): UserDecisionTrace {
  return {
    id: 'tr_1',
    userId: 'local-user',
    sessionId: 's1',
    taskId: 't1',
    turnId: 'turn1',
    workspaceId: 'ws1',
    projectId: 'p1',
    product: 'code',
    initialRequest: prompt,
    agentDecisions: [],
    userEvents: [{
      id: 'e1',
      at: 1,
      actor: 'user',
      type: 'user_message',
      stage: 'task_context',
      text: prompt,
    }],
    createdAt: 1,
    ...extra,
  };
}

describe('UL-P1-03 task-local vs long-term promotion', () => {
  it('a single current-task requirement does not become a long-term User Model', () => {
    const runtime = memoryRuntime({ defaultMode: 'shadow' });
    const opened = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '这次必须修复登录',
    });
    runtime.closeTrace(opened.id, 'completed', 'fixed login');
    const snap = runtime.snapshot();
    expect(snap.userModels.filter((item) => item.status === 'active')).toEqual([]);
    const longTerm = snap.evidence.filter((item) => (
      (item as { durability?: string }).durability === 'long_term_candidate'
      || (item as { durability?: string }).durability === 'authoritative_long_term'
      || item.origin.eventType === 'explicit_statement'
    ));
    expect(longTerm.every((item) => (
      (item as { durability?: string }).durability === 'task_local'
      || (item as { signalKind?: string }).signalKind === 'task_requirement'
    ))).toBe(true);
  });

  it('ordinary task words 必须/应该/优先 extract at most task-local evidence', () => {
    const items = extractEvidenceFromTrace(trace('这次应该优先修登录页，必须先把按钮对齐'), {
      workspaceId: 'ws',
      projectId: 'p',
      scopeTags: [],
      product: 'code',
    });
    expect(items.every((item) => (
      (item as { durability?: string }).durability === 'task_local'
      || (item as { signalKind?: string }).signalKind === 'task_requirement'
    ))).toBe(true);
    expect(items.every((item) => !/长期|协作偏好/.test(item.inference.claim))).toBe(true);
  });

  it('a single stop/cancel does not form a stable conclusion or User Model', () => {
    const runtime = memoryRuntime();
    const opened = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '改一下按钮颜色',
    });
    runtime.recordEvent(opened.id, {
      at: 2,
      actor: 'user',
      type: 'stop',
      stage: 'post_execution',
      text: '停',
    });
    runtime.closeTrace(opened.id, 'cancelled', 'stopped');
    const snap = runtime.snapshot();
    expect(snap.userModels.filter((item) => item.status === 'active')).toEqual([]);
    expect(snap.conclusions.filter((item) => item.status === 'active' && item.temporal.state === 'stable')).toEqual([]);
  });
});
