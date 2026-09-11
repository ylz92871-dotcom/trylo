import { describe, expect, it } from 'vitest';
import { createUserLearningStore } from './store';
import { createUserLearningRuntime } from './runtime';

describe('User Learning failure fallback', () => {
  it('keeps Agent usable when learning is disabled', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: false, defaultMode: 'off', dimensionMode: {}, cognitionEnabled: false },
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/x',
      product: 'code',
      prompt: 'fix bug',
      baseSystemPrompt: 'base',
    });
    expect(prepared.systemPrompt).toBe('base');
    expect(prepared.decision.injected).toBe(false);
  });

  it('closeTrace on unknown id does not throw', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    expect(runtime.closeTrace('missing', 'failed')).toEqual([]);
  });

  it('survives restart via store reload', () => {
    const store = createUserLearningStore({ memoryOnly: true });
    const runtime = createUserLearningRuntime({ store });
    const opened = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'C:/work/demo-ws',
      product: 'code',
      prompt: '减少重复审核，核心 runtime 保留最终验证',
    });
    runtime.closeTrace(opened.id, 'completed', 'ok');
    const snap = store.snapshot();
    expect(snap.evidence.length).toBeGreaterThan(0);
    const store2 = createUserLearningStore({ memoryOnly: true });
    store2.replace(snap);
    const runtime2 = createUserLearningRuntime({ store: store2 });
    expect(runtime2.snapshot().evidence.length).toBe(snap.evidence.length);
  });
});
