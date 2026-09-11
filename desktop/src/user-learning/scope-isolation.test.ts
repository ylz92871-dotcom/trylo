import { describe, expect, it } from 'vitest';
import { synthesizeConclusionBundle } from './conclusion';
import { evidence, memoryRuntime, ruleIds } from './hardening-fixtures';
import { emptySnapshot } from './store';
import { reasonUserModels } from './user-model';

describe('UL-P0-01 scope isolation', () => {
  it('Project A local UI preference does not match, shadow, or enforce in Project B', () => {
    const runtime = memoryRuntime({ defaultMode: 'enforced', cognitionEnabled: false });
    const learned = runtime.openTrace({
      sessionId: 'sa',
      turnId: 'ta',
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '普通 UI 不要反复做同目的 Review',
    });
    runtime.closeTrace(learned.id, 'completed', 'ok');

    const alpha = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '改设置页按钮文案',
      baseSystemPrompt: '',
    });
    const beta = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-beta',
      product: 'code',
      prompt: '改设置页按钮文案',
      baseSystemPrompt: '',
    });

    const alphaIds = new Set(ruleIds(alpha.decision));
    expect(alphaIds.size).toBeGreaterThan(0);
    for (const id of ruleIds(beta.decision)) {
      expect(alphaIds.has(id)).toBe(false);
    }
    const parts = beta.decision as typeof beta.decision & {
      enforced?: readonly { policyId: string }[];
      shadow?: readonly { policyId: string }[];
      off?: readonly { policyId: string }[];
    };
    for (const bucket of [parts.enforced ?? [], parts.shadow ?? [], parts.off ?? []]) {
      for (const rule of bucket) {
        expect(alphaIds.has(rule.policyId)).toBe(false);
      }
    }
    if (alpha.decision.injectionText) {
      expect(beta.decision.injectionText).not.toBe(alpha.decision.injectionText);
    }
    expect(beta.decision.injected).toBe(false);
  });

  it('does not mix Project A and Project B evidence into one dimension conclusion', () => {
    const evA = evidence({
      id: 'ev_a',
      inference: { claim: '用户倾向减少重复、低收益的审核。', semanticConfidence: 0.9, engineeringRelevance: 0.9 },
      context: { workspaceId: 'ws-a', projectId: 'proj-a', scopeTags: ['ui'], product: 'code' },
    });
    const evB = evidence({
      id: 'ev_b',
      inference: { claim: '用户倾向减少重复、低收益的审核。', semanticConfidence: 0.9, engineeringRelevance: 0.9 },
      context: { workspaceId: 'ws-b', projectId: 'proj-b', scopeTags: ['ui'], product: 'code' },
    });
    const out = synthesizeConclusionBundle(
      { ...emptySnapshot(), evidence: [evA, evB] },
      [evA, evB],
      [],
      10,
    );
    const mixed = out.conclusions.filter((item) => (
      item.evidence.supporting.includes('ev_a') && item.evidence.supporting.includes('ev_b')
    ));
    expect(mixed).toEqual([]);
    expect(out.conclusions.some((item) => item.scope.projectId === 'proj-a')).toBe(true);
    expect(out.conclusions.some((item) => item.scope.projectId === 'proj-b')).toBe(true);
  });

  it('does not supersede a Project A user model with a Project B model of the same dimension', () => {
    const evA = evidence({
      id: 'ev_a',
      inference: { claim: '用户倾向减少重复、低收益的审核。', semanticConfidence: 0.9, engineeringRelevance: 0.9 },
      context: { workspaceId: 'ws-a', projectId: 'proj-a', scopeTags: ['ui'], product: 'code' },
    });
    const evB = evidence({
      id: 'ev_b',
      inference: { claim: '核心路径必须保留最终验证。', semanticConfidence: 0.9, engineeringRelevance: 0.9 },
      context: { workspaceId: 'ws-b', projectId: 'proj-b', scopeTags: ['runtime'], product: 'code', corePath: true },
    });
    const snapA = { ...emptySnapshot(), evidence: [evA] };
    const conA = synthesizeConclusionBundle(snapA, [evA], [], 10).conclusions;
    const modelsA = reasonUserModels({ ...snapA, conclusions: conA }, conA, 10).models;
    const snapB = { ...emptySnapshot(), evidence: [evA, evB], userModels: modelsA, conclusions: conA };
    const conB = synthesizeConclusionBundle(snapB, [evB], [], 20).conclusions;
    const modelsB = reasonUserModels({ ...snapB, conclusions: [...conA, ...conB] }, conB, 20).models;
    expect(modelsA.some((item) => item.scope.projectId === 'proj-a')).toBe(true);
    expect(modelsB.every((item) => item.supersedes !== modelsA[0]?.id || item.scope.projectId === modelsA[0]?.scope.projectId)).toBe(true);
  });

  it('Code reporting preference does not become a Work artifact policy by default', () => {
    const runtime = memoryRuntime({ defaultMode: 'enforced' });
    const learned = runtime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '别写那么长的过程叙述，给出产物和风险即可',
    });
    runtime.closeTrace(learned.id, 'completed', 'ok');
    const work = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'work',
      prompt: '写一份周报',
      baseSystemPrompt: '',
    });
    expect(work.decision.injected).toBe(false);
    expect(work.decision.injectionText).toBe('');
  });
});
