import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';

function learn(runtime: ReturnType<typeof createUserLearningRuntime>, prompt: string, turn = 'turn-1') {
  const trace = runtime.openTrace({
    sessionId: 'conversation-1',
    turnId: turn,
    workspaceRoot: 'D:/project',
    product: 'code',
    prompt,
  });
  runtime.closeTrace(trace.id, 'completed', 'ok');
  return trace;
}

describe('LearningReceipt runtime', () => {
  it('emits one pending shadow receipt for a newly retained commitment', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    learn(runtime, '以后汇报先说结论，再按需展开依据');

    const receipts = runtime.listPendingReceipts('code', 'conversation-1');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual(expect.objectContaining({
      reason: 'created',
      state: 'pending',
      message: expect.stringContaining('已记录，尚未用于执行'),
    }));
    expect(new Set(runtime.snapshot().learningReceipts.map((item) => item.dedupeKey)).size)
      .toBe(runtime.snapshot().learningReceipts.length);
  });

  it('activates, pauses and recompiles the commitment atomically', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    learn(runtime, '以后汇报先说结论');
    const commitment = runtime.snapshot().behaviorCommitments.at(-1)!;

    runtime.activateCommitment(commitment.id);
    expect(runtime.snapshot().behaviorCommitments.at(-1)?.state).toBe('active');
    expect(runtime.preparePrompt({
      workspaceRoot: 'D:/project', product: 'code', prompt: '汇报进度', conversationId: 'conversation-2',
    }).decision.enforced)
      .toEqual(expect.arrayContaining([expect.objectContaining({ domain: 'reporting_information_density' })]));
    expect(runtime.listPendingReceipts('code', 'conversation-2')).toEqual([
      expect.objectContaining({ reason: 'first_applied', commitmentId: commitment.id }),
    ]);
    runtime.preparePrompt({ workspaceRoot: 'D:/project', product: 'code', prompt: '再次汇报', conversationId: 'conversation-2' });
    expect(runtime.snapshot().learningReceipts.filter((item) => item.reason === 'first_applied')).toHaveLength(1);

    runtime.pauseCommitment(commitment.id);
    const paused = runtime.snapshot();
    expect(paused.behaviorCommitments.at(-1)?.state).toBe('paused');
    expect(runtime.preparePrompt({ workspaceRoot: 'D:/project', product: 'code', prompt: '汇报进度' }).decision.active)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ domain: 'reporting_information_density' })]));
  });

  it('changes scope by superseding the old commitment and emits a new-version receipt', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    learn(runtime, '以后汇报先说结论');
    const prior = runtime.snapshot().behaviorCommitments.at(-1)!;
    runtime.updateCommitmentScope(prior.id, {
      workspaceId: 'global', projectId: 'global', product: 'code', scopeTags: ['code'],
    });

    const rows = runtime.snapshot().behaviorCommitments;
    expect(rows.find((item) => item.id === prior.id)?.state).toBe('superseded');
    expect(rows.at(-1)).toEqual(expect.objectContaining({ version: 2, supersedes: prior.id }));
    expect(runtime.snapshot().learningReceipts.at(-1)).toEqual(expect.objectContaining({
      commitmentId: rows.at(-1)?.id,
      commitmentVersion: 2,
      reason: 'scope_changed',
    }));
  });

  it('treats “this time only” as a retraction without manufacturing Evidence', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    const trace = learn(runtime, '以后汇报先说结论');
    const before = runtime.snapshot();
    const commitment = before.behaviorCommitments.at(-1)!;
    runtime.applyCommitmentThisTimeOnly(commitment.id, trace.id);

    const after = runtime.snapshot();
    expect(after.evidence).toHaveLength(before.evidence.length);
    expect(after.behaviorCommitments.at(-1)?.state).toBe('retracted');
    expect(after.userModels.find((item) => item.id === commitment.userModelId)?.status).toBe('disputed');
    expect(after.learningReceipts.find((item) => item.commitmentId === commitment.id)?.message)
      .toBe('已设为仅本次，不再用于后续任务');
  });
});
