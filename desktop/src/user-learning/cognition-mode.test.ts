import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import { discoverProjectFacts } from './project-context';

describe('Cognition mode conversation', () => {
  it('first short message opens a chat instead of spawning an agent', async () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    const first = await runtime.handleCognitionTurn('你好', 'C:/work/demo-ws');
    expect(first.reply).toMatch(/怎么跟我干活|工作习惯/);
    expect(first.promptSession?.status).toBe('open');
    expect(runtime.snapshot().cognitionSessions.some((s) => s.status === 'open')).toBe(true);
    expect(first.reply).not.toMatch(/可选：/);
  });

  it('substantial answer becomes Evidence and may follow up in chat', async () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    await runtime.handleCognitionTurn('普通功能直接做，核心架构先计划并保留最终验证。', 'C:/work/demo-ws');
    expect(runtime.snapshot().evidence.some((e) => e.origin.channel === 'cognition')).toBe(true);
    expect(runtime.snapshot().userModels.every((m) => m.derivedFrom.conclusionIds.length > 0)).toBe(true);
  });

  it('dismiss stops asking', async () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    await runtime.handleCognitionTurn('开始了解', 'D:/proj');
    const stop = await runtime.handleCognitionTurn('现在不', 'D:/proj');
    expect(stop.reply).toMatch(/不继续问/);
    expect(stop.dismissedSessionId).toBeTruthy();
  });

  it('impact keep-baseline writes governed evidence without a User Model', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    runtime.recordImpactResolution({
      workspaceRoot: 'D:/proj',
      acceptPersonalization: false,
      reason: 'would drop final verification',
    });
    const snap = runtime.snapshot();
    expect(snap.evidence.some((e) => e.signalKind === 'impact_resolution' || e.origin.eventType === 'cognition_confirmation')).toBe(true);
    expect(snap.userModels.filter((item) => item.status === 'active')).toEqual([]);
  });

  it('in-task answers do not chain the next questionnaire item', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    const session = runtime.startCognition({
      id: 'q_verify_scope',
      dimension: 'verification_audit',
      trigger: 'high_value_gap',
      prompt: '验证偏好？',
      scopeHint: 'v',
    }, 'C:/work/demo-ws');
    const res = runtime.answerCognition(session.id, '低风险直接完成；核心路径仍要最终验证');
    expect(res.followUp).toBe('done');
    const live = runtime.snapshot().cognitionSessions.find((s) => s.id === session.id);
    expect(live?.status).toBe('resolved');
    expect(live?.questions.length).toBe(1);
  });

  it('scope confirmation writes cognition_confirmation Evidence and never directly writes a User Model', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    // Start a cognition question, then answer it with an over-broad,
    // boundary-less phrase → the scope-confirmation loop kicks in
    // (Skill doc §13.3) and the session stays open. The trigger prompt must be
    // in-task relevant (spec §3.2 / §2.2 — a filler or pure gap returns null;
    // a verification-correcting strong signal triggers).
    const first = runtime.maybeCognitionPrompt({ prompt: '改一下持久化迁移，以后不要每次都加独立审核' })!;
    const session = runtime.startCognition(first, 'C:/work/demo-ws');
    const res = runtime.answerCognition(session.id, '都直接做吧，不用再问我了，所有任务都是。');
    expect(res.followUp).toBe('confirm_scope');

    const opened = runtime.snapshot().cognitionSessions.find((s) => s.id === session.id);
    expect(opened?.status).toBe('open');
    expect(opened?.pendingConfirmScope).toBe(true);

    const confirmRes = runtime.confirmCognitionScope(session.id, true);
    expect(confirmRes.followUp).toBe('done');

    const snap = runtime.snapshot();
    expect(snap.evidence.some(
      (e) => e.origin.channel === 'cognition' && e.origin.eventType === 'cognition_confirmation',
    )).toBe(true);
    // The session resolved its pending scope confirm.
    expect(snap.cognitionSessions.find((s) => s.id === session.id)?.pendingConfirmScope).toBeUndefined();

    // Any User Model must derive from Conclusions — no direct write.
    expect(snap.userModels.every(
      (m) => m.status !== 'active' || m.derivedFrom.conclusionIds.length > 0,
    )).toBe(true);
  });
});

describe('Project discovery from workspace facts', () => {
  it('reads languages and tests from directory names', async () => {
    const facts = await discoverProjectFacts('D:/app', {
      listDir: async () => [
        { name: 'package.json', isDirectory: false },
        { name: 'tsconfig.json', isDirectory: false },
        { name: 'src-tauri', isDirectory: true },
        { name: 'e2e', isDirectory: true },
      ],
      gitSnapshot: async () => ({
        repository: true,
        head: 'feat/x',
        entries: [{ path: 'src/foo.test.ts' }],
      }),
    });
    expect(facts.languages).toContain('typescript');
    expect(facts.hasTests).toBe(true);
    expect(facts.gitBranch).toBe('feat/x');
    expect(facts.frameworks).toContain('tauri');
  });
});
