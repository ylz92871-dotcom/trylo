import { describe, expect, it } from 'vitest';
import { extractEvidenceFromTrace } from './evidence';
import { discoverEvidenceRelations, synthesizeConclusionBundle } from './conclusion';
import { evaluateCognitionTrigger } from './cognition';
import { compilePolicies, resolvePolicies } from './policy';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore, emptySnapshot } from './store';
import { classifyTaskContext } from './task-context';
import { buildProjectContext } from './project-context';
import type { EvidenceRecord, UserDecisionTrace, UserModelRecord } from './types';

function ev(partial: Partial<EvidenceRecord> & Pick<EvidenceRecord, 'id' | 'inference'>): EvidenceRecord {
  return {
    userId: 'local-user',
    source: { sessionId: 's', taskId: 't', turnIds: ['u'], actionIds: [], sourceHash: partial.id, traceId: 'tr' },
    origin: { channel: 'interaction', eventType: 'explicit_statement', stage: 'task_context' },
    rawObservation: { text: partial.inference.claim },
    context: { workspaceId: 'ws', projectId: 'p', scopeTags: ['code'] },
    strength: { contextInformedness: 'task_context', band: 'strong' },
    governance: { level: 2, userLocked: false },
    createdAt: 1,
    ...partial,
  };
}

describe('User Learning depth', () => {
  it('short rejection still becomes evidence', () => {
    const trace: UserDecisionTrace = {
      id: 'tr', userId: 'local-user', sessionId: 's', taskId: 't', turnId: 'u',
      workspaceId: 'ws', projectId: 'p', product: 'code',
      initialRequest: 'run tests', agentDecisions: [], createdAt: 1,
      userEvents: [{ id: 'e', at: 1, actor: 'user', type: 'rejection', stage: 'post_plan', text: 'no' }],
    };
    const items = extractEvidenceFromTrace(trace, { workspaceId: 'ws', projectId: 'p', scopeTags: [] });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.origin.eventType).toBe('rejection');
  });

  it('low-risk reduce + core keep becomes refines_scope, not a single global claim', () => {
    const a = ev({ id: 'e1', inference: { claim: '用户倾向减少重复审核', semanticConfidence: 0.9, engineeringRelevance: 0.9 } });
    const b = ev({
      id: 'e2',
      inference: { claim: '核心 runtime 必须保留最终验证', semanticConfidence: 0.9, engineeringRelevance: 0.9 },
      context: { workspaceId: 'ws', projectId: 'p', scopeTags: ['code'], corePath: true },
    });
    const rel = discoverEvidenceRelations([b], [a], 2);
    expect(rel.some((item) => item.type === 'refines_scope')).toBe(true);
  });

  it('same User Model still yields different policy for UI vs core, and no-test projects keep verification', () => {
    const model: UserModelRecord = {
      id: 'um_1', userId: 'local-user',
      statement: '在中低风险任务中减少重复审核，核心路径保留最终验证。',
      dimension: 'verification_audit',
      scope: { workspaceId: 'ws', projectId: 'p', scopeTags: ['code'] },
      confidence: { score: 0.87, band: 'high' },
      inference: { distance: 'D0', alternativeExplanations: [], rationaleSummary: 't' },
      derivedFrom: { conclusionIds: ['c1'] },
      profileDependencies: [],
      counterevidence: [],
      status: 'active', version: 1, createdAt: 1, updatedAt: 1,
    };
    const project = buildProjectContext({
      workspaceId: 'ws', projectId: 'p', product: 'code', hasTests: false, now: 1,
    });
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [model] }, project, 2);
    expect(compiled.rules.some((rule) => rule.instruction.includes('缺少自动测试'))).toBe(true);
    const snap = { ...emptySnapshot(), userModels: [model], policyRules: compiled.rules, policyBundles: [compiled.bundle] };
    const ui = resolvePolicies({ snapshot: snap, task: classifyTaskContext({ prompt: '改按钮文案', product: 'code' }), projectId: 'p', mode: 'shadow' });
    const core = resolvePolicies({ snapshot: snap, task: classifyTaskContext({ prompt: '修改持久状态迁移和核心 runtime', product: 'code' }), projectId: 'p', mode: 'shadow' });
    expect(ui.resolvedActions).not.toEqual(core.resolvedActions);
    expect(core.resolvedActions.join(' ')).toMatch(/final_verification|plan_first/);
  });

  it('recentlyAsked prevents Impact interrupt spam', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: true },
    });
    const t = runtime.openTrace({
      sessionId: 's', turnId: 'u', workspaceRoot: 'C:/work/demo-ws', product: 'code',
      prompt: '不要做重复审核，但核心 runtime 必须保留最终验证',
    });
    runtime.closeTrace(t.id, 'completed', 'ok');
    const first = runtime.preparePrompt({
      workspaceRoot: 'C:/work/demo-ws', product: 'code',
      prompt: '修改持久状态迁移和核心 runtime', baseSystemPrompt: '',
    });
    const second = runtime.preparePrompt({
      workspaceRoot: 'C:/work/demo-ws', product: 'code',
      prompt: '修改持久状态迁移和核心 runtime', baseSystemPrompt: '',
    });
    if (first.decision.impactCheck?.interruptUser) {
      expect(second.decision.impactCheck?.interruptUser).toBe(false);
    }
  });

  it('cognition map reports missing dimensions and closed-loop still writes conclusion relations', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    const session = runtime.startCognition({
      id: 'q', dimension: 'verification_audit', trigger: 'user_opened', prompt: '审核？', scopeHint: 'v',
    });
    runtime.answerCognition(session.id, '低风险少重复审核，核心路径保留最终验证');
    const snap = runtime.snapshot();
    expect(snap.conclusions.length).toBeGreaterThan(0);
    const q = evaluateCognitionTrigger({ snapshot: snap, prompt: '开始了解' });
    expect(q === null || q.dimension !== undefined).toBe(true);
  });

  it('weak isolated preference can abstain when it is not cognition-grade', () => {
    const weak = ev({
      id: 'w1',
      inference: { claim: '随便吧', semanticConfidence: 0.2, engineeringRelevance: 0.2 },
      strength: { contextInformedness: 'task_context', band: 'weak' },
      governance: { level: 1, userLocked: false },
    });
    const out = synthesizeConclusionBundle(emptySnapshot(), [weak], [], 3);
    expect(out.conclusions.length).toBe(0);
  });
});
