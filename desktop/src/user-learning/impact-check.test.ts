import { describe, expect, it } from 'vitest';
import { engineeringBaseline, evaluatePreferenceImpact } from './impact-check';
import { classifyTaskContext } from './task-context';

describe('Preference Impact Check', () => {
  it('does not interrupt low-risk reversible UI work', () => {
    const task = classifyTaskContext({ prompt: '按钮 margin 改成 8px', product: 'code' });
    const check = evaluatePreferenceImpact({
      task,
      decision: {
        resolvedActions: ['avoid:duplicate_review'],
        active: [{ policyId: 'p', domain: 'verification_audit', mode: 'avoid', instruction: 'x', applicationScore: 0.7, reason: '' }],
      },
    });
    expect(task.risk).toBe('low');
    expect(check.interruptUser).toBe(false);
  });

  it('flags high-impact weakening on core/high-risk tasks without always popping', () => {
    const task = classifyTaskContext({ prompt: '修改持久状态迁移和核心 runtime', product: 'code' });
    const check = evaluatePreferenceImpact({
      task,
      decision: {
        resolvedActions: ['prefer:direct_execution'],
        active: [{ policyId: 'p', domain: 'planning_direct_execution', mode: 'prefer', instruction: '直接执行', applicationScore: 0.7, reason: '' }],
      },
    });
    expect(check.triggered).toBe(true);
    expect(engineeringBaseline(task).some((a) => /verif|plan/.test(a))).toBe(true);
    expect(check.interruptUser).toBe(true);
  });

  it('does not interrupt when recently asked', () => {
    const task = classifyTaskContext({ prompt: '数据库 destructive migration', product: 'code' });
    const check = evaluatePreferenceImpact({
      task,
      recentlyAsked: true,
      decision: {
        resolvedActions: ['prefer:direct_execution'],
        active: [{ policyId: 'p', domain: 'planning_direct_execution', mode: 'prefer', instruction: '直接', applicationScore: 0.5, reason: '' }],
      },
    });
    expect(check.interruptUser).toBe(false);
  });
});
