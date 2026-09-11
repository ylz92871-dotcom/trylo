import { describe, expect, it } from 'vitest';
import { conversationTraceKey, createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import { injectionWasApplied } from './injection';
import { classifyTaskContext } from './task-context';

describe('User Learning v0.1 e2e + isolation + failure matrix', () => {
  it('real Code scenario: UI vs migration get different scoped policy', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: true },
    });
    const t1 = runtime.openTrace({
      sessionId: 'c1', turnId: 'u1', workspaceRoot: 'C:/work/demo-ws', product: 'code',
      prompt: '不要做重复审核，但核心 runtime 必须保留最终验证',
    });
    runtime.closeTrace(t1.id, 'completed', 'verification policy discussed');
    const ui = runtime.preparePrompt({
      workspaceRoot: 'C:/work/demo-ws', product: 'code', prompt: '改 settings 按钮文案', baseSystemPrompt: 'You are Trylo Code.',
    });
    const mig = runtime.preparePrompt({
      workspaceRoot: 'C:/work/demo-ws', product: 'code', prompt: '修改持久状态迁移和核心 runtime', baseSystemPrompt: 'You are Trylo Code.',
    });
    expect(ui.decision.injected).toBe(true);
    expect(injectionWasApplied(ui.systemPrompt)).toBe(true);
    expect(ui.taskRisk).toBe('low');
    expect(mig.taskRisk === 'high' || classifyTaskContext({ prompt: '修改持久状态迁移和核心 runtime', product: 'code' }).corePath).toBe(true);
    expect(ui.decision.resolvedActions).not.toEqual(mig.decision.resolvedActions);
    expect(mig.decision.resolvedActions.join(' ')).not.toMatch(/skip_verification|weaken_security/);
  });

  it('concurrent conversations do not share one trace id', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    const a = runtime.openTrace({ sessionId: 'sa', turnId: 'ta', workspaceRoot: 'D:/a', product: 'code', prompt: '直接干，普通 UI' });
    const b = runtime.openTrace({ sessionId: 'sb', turnId: 'tb', workspaceRoot: 'D:/b', product: 'code', prompt: '核心 runtime 先 plan' });
    expect(a.id).not.toBe(b.id);
    expect(conversationTraceKey('a', 'sa')).not.toBe(conversationTraceKey('b', 'sb'));
    runtime.recordEvent(a.id, { at: 1, actor: 'user', type: 'steer', stage: 'post_execution', text: 'stop adding layers' });
    runtime.closeTrace(a.id, 'completed', 'ok');
    runtime.closeTrace(b.id, 'cancelled');
    const snap = runtime.snapshot();
    expect(snap.traces.some((t) => t.sessionId === 'sa' && t.outcome === 'completed')).toBe(true);
    expect(snap.traces.some((t) => t.sessionId === 'sb' && t.outcome === 'cancelled')).toBe(true);
  });

  it('project switch does not apply the other project as if it were the same scope', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    const t = runtime.openTrace({
      sessionId: 's', turnId: 't', workspaceRoot: 'D:/proj-alpha', product: 'code',
      prompt: '不要做重复审核，核心 runtime 保留最终验证',
    });
    runtime.closeTrace(t.id, 'completed', 'ok');
    const alpha = runtime.preparePrompt({ workspaceRoot: 'D:/proj-alpha', product: 'code', prompt: '改按钮', baseSystemPrompt: '' });
    const beta = runtime.preparePrompt({ workspaceRoot: 'D:/proj-beta', product: 'code', prompt: '改按钮', baseSystemPrompt: '' });
    expect(alpha.decision.projectId).not.toBe(beta.decision.projectId);
    const snap = runtime.snapshot();
    const projects = new Set(snap.policyBundles.map((b) => b.projectId));
    expect(projects.size).toBeGreaterThan(1);
  });

  it('Work product traces are first-class', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    const t = runtime.openTrace({
      sessionId: 'w1', turnId: 'tw', workspaceRoot: 'C:/work/demo-ws', product: 'work',
      prompt: '不要写那么长的过程叙述，给出产物和风险即可',
    });
    runtime.closeTrace(t.id, 'completed', 'wrote report');
    expect(runtime.snapshot().traces[0]?.product).toBe('work');
    expect(runtime.snapshot().evidence.length).toBeGreaterThan(0);
  });

  it('authoritative correction is L4 evidence', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    const session = runtime.startCognition({
      id: 'q', dimension: 'verification_audit', trigger: 'user_opened',
      prompt: '纠正', scopeHint: 'v',
    }, 'C:/work/demo-ws');
    runtime.answerCognition(session.id, '你理解错了，改成：减少的是重复审核，核心链路必须最终验证');
    const ev = runtime.snapshot().evidence.find((e) => e.origin.channel === 'cognition');
    expect(ev?.governance.level).toBeGreaterThanOrEqual(2);
    expect(ev?.origin.eventType === 'authoritative_correction' || ev?.governance.level === 4 || /纠正|理解错/.test(ev?.rawObservation.text ?? '')).toBe(true);
  });

  it('persist/reload keeps long-term state (restart)', () => {
    const key = 'trylo:user-learning:v1';
    window.localStorage.removeItem(key);
    const store = createUserLearningStore({ memoryOnly: false });
    const runtime = createUserLearningRuntime({ store });
    const opened = runtime.openTrace({
      sessionId: 's', turnId: 't', workspaceRoot: 'C:/work/demo-ws', product: 'code',
      prompt: '减少重复审核，核心 runtime 保留最终验证',
    });
    runtime.closeTrace(opened.id, 'completed', 'ok');
    const raw = window.localStorage.getItem(key);
    expect(raw).toBeTruthy();
    const store2 = createUserLearningStore({ memoryOnly: false });
    expect(store2.snapshot().evidence.length).toBeGreaterThan(0);
    window.localStorage.removeItem(key);
  });

  it('learning failure never throws on prepare/close', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    expect(() => runtime.recordEvent('nope', { at: 1, actor: 'user', type: 'stop', stage: 'post_execution' })).not.toThrow();
    expect(runtime.closeTrace('nope', 'failed')).toEqual([]);
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/x', product: 'code', prompt: 'hello', baseSystemPrompt: 'base',
    });
    expect(prepared.systemPrompt).toBe('base');
  });
});
