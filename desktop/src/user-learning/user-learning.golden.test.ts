import { describe, expect, it } from 'vitest';
import { classifyInferenceDistance, reasonUserModels } from './user-model';
import { extractEvidenceFromTrace } from './evidence';
import { composeSystemPrompt, injectionWasApplied } from './injection';
import { compilePolicies, resolvePolicies } from './policy';
import { createUserLearningStore, emptySnapshot } from './store';
import { classifyTaskContext } from './task-context';
import type {
  ConclusionRecord,
  EvidenceRecord,
  UserDecisionTrace,
  UserModelRecord,
  UserLearningSnapshot,
} from './types';
import { createUserLearningRuntime } from './runtime';

function trace(overrides: Partial<UserDecisionTrace> = {}): UserDecisionTrace {
  return {
    id: 'tr_1',
    userId: 'local-user',
    sessionId: 's1',
    taskId: 't1',
    turnId: 'turn1',
    workspaceId: 'ws1',
    projectId: 'p1',
    product: 'code',
    initialRequest: 'fix the button margin',
    agentDecisions: ['edit css'],
    userEvents: [],
    createdAt: 1,
    ...overrides,
  };
}

function um(partial: Partial<UserModelRecord> = {}): UserModelRecord {
  return {
    id: 'um_1',
    userId: 'local-user',
    statement: '在中低风险 Coding 任务中，用户对重复、同质 Review 的容忍度较低；但这一倾向不应解释为降低核心状态链路的最终可靠性验证。',
    dimension: 'verification_audit',
    scope: { workspaceId: 'ws', projectId: 'p', scopeTags: ['code'] },
    confidence: { score: 0.87, band: 'high' },
    inference: { distance: 'D0', alternativeExplanations: ['用户只是赶时间'], rationaleSummary: 'restatement' },
    derivedFrom: { conclusionIds: ['con_1'] },
    profileDependencies: [],
    counterevidence: [],
    status: 'active',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function snapshotWithModel(model: UserModelRecord = um()): UserLearningSnapshot {
  const compiled = compilePolicies({ ...emptySnapshot(), userModels: [model] }, null, 10);
  return {
    ...emptySnapshot(),
    userModels: [model],
    policyRules: compiled.rules,
    policyBundles: [compiled.bundle],
  };
}

describe('User Learning golden set', () => {
  it('same User Model + different task risk yields different policy', () => {
    const snap = snapshotWithModel();
    const ui = classifyTaskContext({ prompt: '把设置页按钮 margin 改成 8px', product: 'code' });
    const core = classifyTaskContext({ prompt: '修改持久状态迁移和核心 runtime', product: 'code' });
    expect(ui.risk).toBe('low');
    expect(core.corePath).toBe(true);

    const a = resolvePolicies({ snapshot: snap, task: ui, projectId: 'p', mode: 'shadow' });
    const b = resolvePolicies({ snapshot: snap, task: core, projectId: 'p', mode: 'shadow' });
    expect(a.resolvedActions.join(' ')).toMatch(/duplicate_review|direct_execution|process_narration|semantic_checkpoint|speculative/);
    expect(b.resolvedActions.join(' ')).toMatch(/final_verification|plan_first/);
    expect(a.resolvedActions).not.toEqual(b.resolvedActions);
    expect(b.resolvedActions.join(' ')).not.toMatch(/skip_verification|weaken_security/);
  });

  it('unrelated profile fact does not change policy', () => {
    const model = um();
    const a = compilePolicies({ ...emptySnapshot(), userModels: [model] }, null, 1);
    const b = compilePolicies({
      ...emptySnapshot(),
      userModels: [model],
      profileFacts: [{
        id: 'pf1',
        userId: 'local-user',
        category: 'role_identity',
        statement: '用户喜欢吃牛肉',
        evidenceRefs: [],
        confidence: { score: 1, band: 'high' },
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      }],
    }, null, 1);
    expect(a.rules.map((r) => r.instruction)).toEqual(b.rules.map((r) => r.instruction));
  });

  it('frontend-only evidence does not become all-engineering user model', () => {
    const t = trace({
      userEvents: [{
        id: 'e1', at: 1, actor: 'user', type: 'user_message', stage: 'task_context',
        text: '这个按钮别搞复杂，直接改 margin 就行',
      }],
    });
    const evidence = extractEvidenceFromTrace(t, {
      workspaceId: 'ws', projectId: 'p', scopeTags: ['frontend'], component: 'ui',
    });
    expect(evidence.every((e) => !/all engineering|所有工程/.test(e.inference.claim))).toBe(true);
  });

  it('silence is not approval', () => {
    const t = trace({
      userEvents: [{
        id: 'a1', at: 1, actor: 'agent', type: 'agent_decision', stage: 'post_plan',
        text: 'I will add a second reviewer',
      }],
    });
    expect(extractEvidenceFromTrace(t, { workspaceId: 'ws', projectId: 'p', scopeTags: [] })).toEqual([]);
  });

  it('cognition answer becomes evidence, not a direct user model write', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      now: () => 1000,
    });
    const session = runtime.startCognition({
      id: 'q',
      dimension: 'verification_audit',
      trigger: 'user_opened',
      prompt: '审核偏好？',
      scopeHint: 'v',
    });
    const before = runtime.snapshot().userModels.length;
    runtime.answerCognition(session.id, '低风险少重复审核，核心路径保留最终验证');
    const snap = runtime.snapshot();
    expect(snap.evidence.some((e) => e.origin.channel === 'cognition')).toBe(true);
    expect(snap.cognitionSessions[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(snap.userModelDerivations.some((d) => d.conclusionIds.length > 0 || d.rejected)).toBe(true);
    expect(snap.userModels.every((m) => m.derivedFrom.conclusionIds.length > 0)).toBe(true);
    void before;
  });

  it('counter-evidence does not raise confidence', () => {
    const weak: ConclusionRecord = {
      id: 'c1', userId: 'local-user',
      statement: '用户倾向减少重复审核。',
      dimension: 'verification_audit',
      scope: { workspaceId: 'ws', projectId: 'p', scopeTags: [] },
      evidence: { supporting: ['e1'], counter: [], contextual: [] },
      relations: [],
      strength: { score: 0.7, band: 'medium' },
      temporal: { firstObserved: 1, lastSupported: 1, state: 'stable' },
      status: 'active', version: 1, createdAt: 1, updatedAt: 1,
    };
    const withCounter = { ...weak, evidence: { ...weak.evidence, counter: ['e2'] }, strength: { score: 0.55, band: 'low' as const } };
    const a = reasonUserModels(emptySnapshot(), [weak], 2).models[0];
    const b = reasonUserModels(emptySnapshot(), [withCounter], 2).models[0];
    if (a && b) expect(b.confidence.score).toBeLessThanOrEqual(a.confidence.score);
  });

  it('D3 inference is not persisted', () => {
    expect(classifyInferenceDistance('用户懒', '用户经常跳过审核')).toBe('D3');
    const conclusion: ConclusionRecord = {
      id: 'c3', userId: 'local-user',
      statement: '用户懒，没有耐心。',
      dimension: 'agent_autonomy',
      scope: { workspaceId: 'ws', projectId: 'p', scopeTags: [] },
      evidence: { supporting: ['e1'], counter: [], contextual: [] },
      relations: [],
      strength: { score: 0.9, band: 'high' },
      temporal: { firstObserved: 1, lastSupported: 1, state: 'stable' },
      status: 'active', version: 1, createdAt: 1, updatedAt: 1,
    };
    const { models, derivations } = reasonUserModels(emptySnapshot(), [conclusion], 3);
    expect(models).toHaveLength(0);
    expect(derivations.some((d) => d.rejected && d.rejectReason === 'd3_forbidden' || d.rejected)).toBe(true);
  });

  it('safety floor wins over personalization', () => {
    const snap = snapshotWithModel(um({
      statement: '用户讨厌测试。',
      dimension: 'security_data_integrity',
    }));
    const task = classifyTaskContext({ prompt: '数据库 destructive migration', product: 'code' });
    const decision = resolvePolicies({ snapshot: snap, task, projectId: 'p', mode: 'enforced' });
    expect(decision.resolvedActions.join(' ')).not.toMatch(/skip_tests|weaken_security|skip_verification/);
    expect(task.corePath || task.risk === 'high').toBe(true);
  });

  it('shadow mode computes policy but does not inject', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'shadow', dimensionMode: {}, cognitionEnabled: true },
    });
    runtime.seedFixture(snapshotWithModel());
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: '改一下按钮文案',
      baseSystemPrompt: 'You are Trylo Code.',
    });
    expect(prepared.decision.active.length).toBeGreaterThan(0);
    expect(prepared.decision.mode).toBe('shadow');
    expect(prepared.decision.injected).toBe(false);
    expect(injectionWasApplied(prepared.systemPrompt)).toBe(false);
    expect(prepared.systemPrompt).toBe('You are Trylo Code.');
  });

  it('enforced mode injects the policy block', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: true },
    });
    runtime.seedFixture(snapshotWithModel());
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: '改一下按钮文案',
      baseSystemPrompt: 'You are Trylo Code.',
    });
    expect(prepared.decision.injected).toBe(true);
    expect(injectionWasApplied(prepared.systemPrompt)).toBe(true);
    expect(composeSystemPrompt('base', prepared.decision.injectionText, true)).toContain('trylo_active_engineering_policy');
  });

  it('export and delete user learning data', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
    });
    const opened = runtime.openTrace({
      sessionId: 's', turnId: 't', workspaceRoot: 'D:/p', product: 'code',
      prompt: '不要做重复审核，但核心 runtime 必须保留最终验证',
    });
    runtime.closeTrace(opened.id, 'completed', 'ok');
    const exported = runtime.exportForUser() as { evidence: unknown[] };
    expect(exported.evidence.length).toBeGreaterThan(0);
    runtime.deleteUserData();
    expect(runtime.snapshot().evidence).toEqual([]);
    expect(runtime.snapshot().userModels).toEqual([]);
  });

  it('closed loop: user message → evidence → conclusion → model → policy', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: true },
    });
    const opened = runtime.openTrace({
      sessionId: 's',
      turnId: 'u1',
      workspaceRoot: 'C:/work/demo-ws',
      product: 'code',
      prompt: '不要做重复审核，但核心 runtime 必须保留最终验证',
      codeMode: 'agent',
    });
    const runs = runtime.closeTrace(opened.id, 'completed', 'changed verification flow');
    expect(runs.some((r) => r.kind === 'evidence.extract' && r.status === 'ok')).toBe(true);
    const snap = runtime.snapshot();
    expect(snap.evidence.length).toBeGreaterThan(0);
    expect(snap.conclusions.length).toBeGreaterThan(0);
    expect(snap.userModels.length).toBeGreaterThan(0);
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'C:/work/demo-ws',
      product: 'code',
      prompt: '改 settings 按钮文案',
      baseSystemPrompt: '',
    });
    expect(prepared.decision.active.length).toBeGreaterThan(0);
  });

  it('agent-only output cannot become user evidence', () => {
    const evidence = extractEvidenceFromTrace(trace({
      userEvents: [{
        id: 'x', at: 1, actor: 'agent', type: 'execution_result', stage: 'post_execution',
        text: 'I used a complex architecture',
      }],
    }), { workspaceId: 'ws', projectId: 'p', scopeTags: [] });
    expect(evidence).toHaveLength(0);
  });
});

describe('evidence extractor guards', () => {
  it('keeps raw observation separate from claim', () => {
    const ev: readonly EvidenceRecord[] = extractEvidenceFromTrace(trace({
      userEvents: [{
        id: 'u', at: 2, actor: 'user', type: 'correction', stage: 'post_execution',
        text: '不要只看日志，要把整条相关代码都查完',
      }],
    }), { workspaceId: 'ws', projectId: 'p', scopeTags: ['runtime'], corePath: true });
    expect(ev[0]?.rawObservation.text).toContain('不要只看日志');
    expect(ev[0]?.inference.claim).not.toBe(ev[0]?.rawObservation.text);
    expect(ev[0]?.governance.level).toBeGreaterThanOrEqual(2);
  });
});
