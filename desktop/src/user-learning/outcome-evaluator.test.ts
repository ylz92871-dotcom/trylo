import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';

function learnCommitment(runtime: ReturnType<typeof createUserLearningRuntime>) {
  const trace = runtime.openTrace({
    sessionId: 'learning-session', turnId: 'learn-1', workspaceRoot: 'D:/project',
    product: 'code', prompt: '以后汇报先说结论',
  });
  runtime.closeTrace(trace.id, 'completed', 'ok');
  const commitment = runtime.snapshot().behaviorCommitments.at(-1)!;
  runtime.activateCommitment(commitment.id);
  return commitment.id;
}

function runAppliedTask(
  runtime: ReturnType<typeof createUserLearningRuntime>,
  turnId: string,
  feedback?: { type: 'outcome_feedback' | 'correction' | 'rollback' | 'manual_edit'; text: string },
) {
  const trace = runtime.openTrace({
    sessionId: 'work-session', turnId, workspaceRoot: 'D:/project',
    product: 'code', prompt: '汇报本次修改',
  });
  const prepared = runtime.preparePrompt({
    workspaceRoot: 'D:/project', product: 'code', prompt: '汇报本次修改',
    conversationId: 'work-session', turnId,
  });
  if (feedback) {
    runtime.recordEvent(trace.id, {
      actor: 'user', type: feedback.type, text: feedback.text,
      stage: 'post_outcome', at: Date.now(),
    });
  }
  runtime.closeTrace(trace.id, 'completed', 'ok');
  return prepared;
}

describe('OutcomeObservation pipeline', () => {
  it('binds comparable opportunities to commitments that were actually injected', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    const commitmentId = learnCommitment(runtime);
    const prepared = runAppliedTask(runtime, 'task-1', { type: 'outcome_feedback', text: '这样更好，保持这样' });

    expect(prepared.decision.appliedCommitmentIds).toEqual([commitmentId]);
    expect(prepared.decision.opportunityKeys[0]).toMatch(/^report\.section_order::code::/);
    expect(runtime.snapshot().outcomeObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ commitmentId, signal: 'explicit_helpful', attribution: 'direct' }),
      expect.objectContaining({ commitmentId, signal: 'task_completed', attribution: 'unknown' }),
    ]));
    const commitment = runtime.snapshot().behaviorCommitments.find((item) => item.id === commitmentId)!;
    expect(runtime.snapshot().userModels.find((item) => item.id === commitment.userModelId)).toEqual(
      expect.objectContaining({ effectivenessState: 'helpful', lastRelevantOpportunityAt: expect.any(Number) }),
    );
  });

  it('pauses an active commitment atomically after explicit negative feedback', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    const commitmentId = learnCommitment(runtime);
    runAppliedTask(runtime, 'task-negative', { type: 'outcome_feedback', text: '不对，恢复以前方式' });

    expect(runtime.snapshot().behaviorCommitments.find((item) => item.id === commitmentId)?.state).toBe('paused');
    expect(runtime.snapshot().outcomeObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ commitmentId, signal: 'explicit_unhelpful' }),
    ]));
    const commitment = runtime.snapshot().behaviorCommitments.find((item) => item.id === commitmentId)!;
    expect(runtime.snapshot().userModels.find((item) => item.id === commitment.userModelId)?.effectivenessState)
      .toBe('harmful');
    expect(runtime.listPendingReceipts('code', 'work-session')).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'correction_detected', message: expect.stringContaining('已暂停') }),
    ]));
    expect(runtime.preparePrompt({ workspaceRoot: 'D:/project', product: 'code', prompt: '汇报进度' }).decision.appliedCommitmentIds)
      .not.toContain(commitmentId);
  });

  it('does not treat task completion alone as positive evidence', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    const commitmentId = learnCommitment(runtime);
    runAppliedTask(runtime, 'task-complete');
    const rows = runtime.snapshot().outcomeObservations.filter((item) => item.commitmentId === commitmentId);
    expect(rows.some((item) => item.signal === 'task_completed')).toBe(true);
    expect(rows.some((item) => item.signal === 'explicit_helpful')).toBe(false);
    const commitment = runtime.snapshot().behaviorCommitments.find((item) => item.id === commitmentId)!;
    expect(runtime.snapshot().userModels.find((item) => item.id === commitment.userModelId)?.effectivenessState)
      .toBe('unknown');
  });

  it('pauses after the same correction repeats twice beyond its first occurrence', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    const commitmentId = learnCommitment(runtime);
    for (const turn of ['correction-1', 'correction-2', 'correction-3']) {
      runAppliedTask(runtime, turn, { type: 'correction', text: '章节顺序调整一下' });
    }
    expect(runtime.snapshot().outcomeObservations.filter((item) => (
      item.commitmentId === commitmentId && item.signal === 'repeated_correction'
    ))).toHaveLength(2);
    expect(runtime.snapshot().behaviorCommitments.find((item) => item.id === commitmentId)?.state).toBe('paused');
  });
});
