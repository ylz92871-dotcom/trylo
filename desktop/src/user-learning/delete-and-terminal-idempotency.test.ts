import { describe, expect, it } from 'vitest';
import type { LearningLlm } from './llm';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';

describe('user-learning deletion and terminal idempotency', () => {
  it('learns a closed trace exactly once and rejects late events', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    const trace = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'D:/project',
      product: 'code',
      prompt: '以后不要做重复审核，但核心路径保留最终验证',
    });

    runtime.closeTrace(trace.id, 'completed', 'ok');
    const learned = runtime.snapshot();
    const second = runtime.closeTrace(trace.id, 'completed', 'ok');
    runtime.recordEvent(trace.id, {
      at: 99,
      actor: 'user',
      type: 'correction',
      stage: 'post_outcome',
      text: 'late event must not reopen the trace',
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe('skipped');
    expect(second[0]?.reasonCode).toBe('idempotent');
    expect(runtime.snapshot().traceLearningCommits).toEqual([
      expect.objectContaining({ traceId: trace.id, status: 'committed' }),
    ]);
    expect(runtime.snapshot().evidence).toEqual(learned.evidence);
    expect(runtime.snapshot().conclusions).toEqual(learned.conclusions);
    expect(runtime.snapshot().traces.find((item) => item.id === trace.id)?.userEvents)
      .toEqual(learned.traces.find((item) => item.id === trace.id)?.userEvents);
    expect(runtime.snapshot().diagnostics?.lastRejectedLateEvent).toEqual(expect.objectContaining({
      traceId: trace.id,
      eventType: 'correction',
    }));

    runtime.closeTrace(trace.id, 'failed', 'different terminal callback');
    expect(runtime.snapshot().diagnostics?.lastTerminalConflict).toEqual(expect.objectContaining({
      traceId: trace.id,
      committedOutcome: 'completed',
      attemptedOutcome: 'failed',
    }));
    expect(runtime.snapshot().evidence).toEqual(learned.evidence);
  });

  it('does not let an in-flight assisted result resurrect deleted data', async () => {
    let resolveCall: ((value: string | null) => void) | undefined;
    const llm: LearningLlm = {
      complete: () => new Promise((resolve) => {
        resolveCall = resolve;
      }),
    };
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      llm,
      settings: {
        enabled: true,
        defaultMode: 'shadow',
        dimensionMode: {},
        cognitionEnabled: true,
        inference: {
          enabled: true,
          mode: 'assisted',
          allowExecutionContext: false,
          maxCallsPerHour: 12,
          maxCallsPerTrace: 1,
        },
      },
    });
    const trace = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'D:/project',
      product: 'code',
      prompt: '以后报告先说结论',
    });
    runtime.closeTrace(trace.id, 'completed', 'ok');
    const pending = runtime.enrichAfterTrace(trace.id);
    await Promise.resolve();

    runtime.deleteUserData();
    resolveCall?.('{"evidence":[]}');
    await pending;

    expect(runtime.snapshot().traces).toEqual([]);
    expect(runtime.snapshot().evidence).toEqual([]);
    expect(runtime.snapshot().userModels).toEqual([]);
    expect(runtime.snapshot().policyRules).toEqual([]);
  });

  it('drops an open trace when all user-learning data is deleted', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    const trace = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'D:/project',
      product: 'work',
      prompt: 'draft',
    });

    runtime.deleteUserData();

    expect(runtime.closeTrace(trace.id, 'completed', 'late')).toEqual([]);
    expect(runtime.snapshot().traces).toEqual([]);
  });
});
