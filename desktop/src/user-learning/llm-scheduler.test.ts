import { describe, expect, it } from 'vitest';
import { memoryRuntime } from './hardening-fixtures';
import type { LearningLlm } from './llm';

describe('UL-P1-05 learning scheduler / LLM budget', () => {
  it('ordinary completed tasks make zero Learning LLM calls when assisted mode is off', async () => {
    const calls: string[] = [];
    const llm: LearningLlm = {
      async complete(skill) {
        calls.push(skill);
        return JSON.stringify({ evidence: [] });
      },
    };
    const runtime = memoryRuntime({ defaultMode: 'shadow' });
    const scheduled = runtime as typeof runtime & { readonly llm?: LearningLlm };
    void scheduled;
    const withLlm = (await import('./runtime')).createUserLearningRuntime({
      store: (await import('./store')).createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'shadow', dimensionMode: {}, cognitionEnabled: false },
      llm,
    });
    for (let i = 0; i < 20; i += 1) {
      const opened = withLlm.openTrace({
        sessionId: `s${i}`,
        turnId: `t${i}`,
        workspaceRoot: 'D:/proj-alpha',
        product: 'code',
        prompt: `改一下按钮颜色 ${i}`,
      });
      withLlm.closeTrace(opened.id, 'completed', `ok ${i}`);
      await withLlm.enrichAfterTrace(opened.id);
    }
    expect(calls).toEqual([]);
  });

  it('main Agent API key presence is not enough to enable learning LLM', async () => {
    const calls: string[] = [];
    const llm: LearningLlm = {
      async complete(skill) {
        calls.push(skill);
        return '{}';
      },
    };
    const { createUserLearningRuntime } = await import('./runtime');
    const { createUserLearningStore } = await import('./store');
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      llm,
    });
    const opened = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '改按钮',
    });
    runtime.closeTrace(opened.id, 'completed', 'ok');
    await runtime.enrichAfterTrace(opened.id);
    expect(calls).toEqual([]);
  });
});
