import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import type { LearningLlm } from './llm';

describe('assisted learning deterministic commit', () => {
  it('uses the model only for Evidence candidates and commits deterministic downstream state', async () => {
    const calls: string[] = [];
    let eventId = '';
    const llm: LearningLlm = {
      metadata: { provider: 'openai', model: 'test-model' },
      async complete(skill) {
        calls.push(skill);
        if (skill !== 'evidence') throw new Error(`unexpected ${skill} call`);
        return JSON.stringify({ evidence: [{
          claim: '用户倾向减少重复、低收益的审核。', raw: '不要做重复审核',
          event_id: eventId,
          event_type: 'explicit_statement', semantic_confidence: 0.9,
          engineering_relevance: 0.9, governance_level: 2,
        }] });
      },
    };
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: {
        enabled: true, defaultMode: 'shadow', dimensionMode: {}, cognitionEnabled: false,
        inference: {
          enabled: true, mode: 'assisted', allowExecutionContext: false,
          maxCallsPerHour: 12, maxCallsPerTrace: 1,
        },
      },
      llm,
    });
    const trace = runtime.openTrace({
      sessionId: 's', turnId: 't', workspaceRoot: 'D:/proj-alpha',
      product: 'code', prompt: '不要做重复审核',
    });
    eventId = trace.userEvents[0]!.id;
    runtime.closeTrace(trace.id, 'completed', 'ok');

    await runtime.enrichAfterTrace(trace.id);
    await runtime.enrichAfterTrace(trace.id);

    expect(calls).toEqual(['evidence']);
    expect(runtime.snapshot().learningCallLedger).toEqual([
      expect.objectContaining({
        traceId: trace.id, skill: 'evidence', provider: 'openai',
        model: 'test-model', status: 'completed',
      }),
    ]);
    expect(runtime.snapshot().evidence.some((item) => item.inference.claim.includes('重复'))).toBe(true);
  });
});
