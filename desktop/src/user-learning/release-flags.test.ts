import { describe, expect, it } from 'vitest';
import { prepareLearningInteraction } from './learning-interaction-coordinator';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';

function runtime() {
  return createUserLearningRuntime({
    store: createUserLearningStore({ memoryOnly: true }),
    settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: true },
  });
}

function activeReportingCommitment(rt: ReturnType<typeof runtime>): string {
  const trace = rt.openTrace({
    sessionId: 'learn', turnId: 'learn-1', workspaceRoot: 'D:/project',
    product: 'code', prompt: '以后汇报先说结论',
  });
  rt.closeTrace(trace.id, 'completed', 'ok');
  const commitment = rt.snapshot().behaviorCommitments.at(-1)!;
  rt.activateCommitment(commitment.id);
  return commitment.id;
}

describe('User Learning v0.2 release flags', () => {
  it('coordinator rollback keeps prompt preparation but suppresses proactive Cognition', () => {
    const rt = runtime();
    rt.setSettings({ userLearningV2Coordinator: false });
    const result = prepareLearningInteraction(rt, {
      workspaceRoot: 'D:/project', conversationId: 'conversation', turnId: 'turn-1',
      product: 'code', prompt: '改一下持久化迁移，以后不要每次都加独立审核',
      settings: rt.settings(), hasPendingLearningUi: false,
    });
    expect(result.prepared.start).toBe('ready');
    expect(result.cognition).toBeUndefined();
    expect(rt.snapshot().cognitionSessions).toHaveLength(0);
  });

  it('BehaviorCommitment rollback excludes only commitment-backed rules from application', () => {
    const rt = runtime();
    const commitmentId = activeReportingCommitment(rt);
    rt.setSettings({ userLearningBehaviorCommitments: false });
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/project', product: 'code', prompt: '汇报本次修改',
    });
    expect(prepared.decision.appliedCommitmentIds).not.toContain(commitmentId);
    expect(prepared.decision.off.length).toBeGreaterThan(0);
    expect(prepared.decision.injectionText).toBe('');
  });

  it('Receipts rollback hides retained v5 receipts without deleting them', () => {
    const rt = runtime();
    activeReportingCommitment(rt);
    expect(rt.snapshot().learningReceipts.length).toBeGreaterThan(0);
    rt.setSettings({ userLearningReceipts: false });
    expect(rt.listPendingReceipts('code')).toEqual([]);
    expect(rt.snapshot().learningReceipts.length).toBeGreaterThan(0);
  });

  it('Outcome rollback records no evaluation observations', () => {
    const rt = runtime();
    activeReportingCommitment(rt);
    rt.setSettings({ userLearningOutcomeEvaluation: false });
    const trace = rt.openTrace({
      sessionId: 'task', turnId: 'task-1', workspaceRoot: 'D:/project',
      product: 'code', prompt: '汇报本次修改',
    });
    rt.preparePrompt({
      workspaceRoot: 'D:/project', product: 'code', prompt: '汇报本次修改',
      conversationId: 'task', turnId: 'task-1',
    });
    rt.recordEvent(trace.id, {
      actor: 'user', type: 'outcome_feedback', stage: 'post_outcome',
      text: '不对，恢复以前方式', at: Date.now(),
    });
    rt.closeTrace(trace.id, 'completed', 'ok');
    expect(rt.snapshot().outcomeObservations).toEqual([]);
  });
});
