import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';

function runtimeWithActiveCommitment() {
  const runtime = createUserLearningRuntime({
    store: createUserLearningStore({ memoryOnly: true }),
    settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
  });
  const learned = runtime.openTrace({
    sessionId: 'learn', turnId: 'learn-1', workspaceRoot: 'D:/project',
    product: 'code', prompt: '以后汇报先说结论',
  });
  runtime.closeTrace(learned.id, 'completed', 'ok');
  const commitment = runtime.snapshot().behaviorCommitments.at(-1)!;
  runtime.activateCommitment(commitment.id);
  return { runtime, commitmentId: commitment.id };
}

function openPrepared(
  runtime: ReturnType<typeof createUserLearningRuntime>,
  turnId: string,
  learningDirective?: Parameters<typeof runtime.openTrace>[0]['learningDirective'],
) {
  const trace = runtime.openTrace({
    sessionId: 'task-session', turnId, workspaceRoot: 'D:/project',
    product: 'code', prompt: '汇报本次修改', learningDirective,
  });
  const prepared = runtime.preparePrompt({
    workspaceRoot: 'D:/project', product: 'code', prompt: '汇报本次修改',
    conversationId: 'task-session', turnId,
  });
  return { trace, prepared };
}

describe('per-trace LearningDirective', () => {
  it('can skip existing preferences while still collecting new learning', () => {
    const { runtime, commitmentId } = runtimeWithActiveCommitment();
    const evidenceBefore = runtime.snapshot().evidence.length;
    const { trace, prepared } = openPrepared(runtime, 'no-apply', {
      applyExistingPreferences: false, collectNewLearning: true, retention: 'normal',
    });
    expect(prepared.decision.appliedCommitmentIds).toEqual([]);
    expect(prepared.decision.off.length).toBeGreaterThan(0);
    runtime.recordEvent(trace.id, {
      actor: 'user', type: 'correction', stage: 'task_context',
      text: '以后请先给结论，再补充实现细节', at: Date.now(),
    });
    runtime.closeTrace(trace.id, 'completed', 'ok');
    expect(runtime.snapshot().evidence.length).toBeGreaterThan(evidenceBefore);
    expect(runtime.snapshot().behaviorCommitments.find((item) => item.id === commitmentId)).toBeDefined();
  });

  it('can apply preferences without invoking the Evidence extractor', () => {
    const { runtime, commitmentId } = runtimeWithActiveCommitment();
    const evidenceBefore = runtime.snapshot().evidence.length;
    const outcomeBefore = runtime.snapshot().outcomeObservations.length;
    const { trace, prepared } = openPrepared(runtime, 'no-collect', {
      applyExistingPreferences: true, collectNewLearning: false, retention: 'normal',
    });
    expect(prepared.decision.appliedCommitmentIds).toContain(commitmentId);
    runtime.recordEvent(trace.id, {
      actor: 'user', type: 'outcome_feedback', stage: 'post_outcome',
      text: '不对，恢复以前方式', at: Date.now(),
    });
    runtime.closeTrace(trace.id, 'completed', 'ok');
    const snapshot = runtime.snapshot();
    expect(snapshot.evidence).toHaveLength(evidenceBefore);
    expect(snapshot.outcomeObservations).toHaveLength(outcomeBefore);
    expect(snapshot.learningRuns.at(-1)).toEqual(expect.objectContaining({
      kind: 'evidence.extract', status: 'skipped', reasonCode: 'directive_no_collect',
    }));
    expect(snapshot.behaviorCommitments.find((item) => item.id === commitmentId)?.state).toBe('active');
  });

  it('scrubs trace content after an incognito task and leaves only lifecycle diagnostics', () => {
    const { runtime } = runtimeWithActiveCommitment();
    const evidenceBefore = runtime.snapshot().evidence.length;
    const { trace, prepared } = openPrepared(runtime, 'incognito', {
      applyExistingPreferences: false,
      collectNewLearning: false,
      retention: 'session_only',
      reason: 'user_requested_private',
    });
    expect(prepared.decision.appliedCommitmentIds).toEqual([]);
    runtime.closeTrace(trace.id, 'completed', 'sensitive output');
    const stored = runtime.snapshot().traces.find((item) => item.id === trace.id)!;
    expect(stored).toEqual(expect.objectContaining({
      initialRequest: '', agentDecisions: [], userEvents: [], outcome: 'completed',
    }));
    expect(stored.executionResult).toBeUndefined();
    expect(runtime.snapshot().evidence).toHaveLength(evidenceBefore);
    expect(runtime.snapshot().traceLearningCommits.some((item) => item.traceId === trace.id)).toBe(true);
  });

  it('freezes the directive at openTrace', () => {
    const { runtime, commitmentId } = runtimeWithActiveCommitment();
    const directive = {
      applyExistingPreferences: false, collectNewLearning: false, retention: 'normal' as const,
    };
    const { trace } = openPrepared(runtime, 'frozen', directive);
    // Mutating the caller-owned object cannot alter the stored run directive.
    directive.applyExistingPreferences = true;
    directive.collectNewLearning = true;
    expect(runtime.snapshot().traces.find((item) => item.id === trace.id)?.learningDirective)
      .toEqual({ applyExistingPreferences: false, collectNewLearning: false, retention: 'normal' });
    expect(runtime.preparePrompt({
      workspaceRoot: 'D:/project', product: 'code', prompt: '汇报',
      conversationId: 'task-session', turnId: 'frozen',
    }).decision.appliedCommitmentIds).not.toContain(commitmentId);
  });
});
