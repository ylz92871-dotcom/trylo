import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import { parsePolicySkillOutput, parseUserModelSkillOutput } from './skills';
import type { ConclusionRecord } from './types';
import type { LearningLlm } from './llm';

function mockLlm(replies: Record<string, unknown>): LearningLlm {
  return {
    async complete(skill) {
      return JSON.stringify(replies[skill] ?? {});
    },
  };
}

describe('Skill parsers (docs → code)', () => {
  it('rejects D3 user models', () => {
    const conclusion: ConclusionRecord = {
      id: 'c1', userId: 'local-user', statement: '多次跳过重复 review',
      dimension: 'verification_audit',
      scope: { workspaceId: 'w', projectId: 'p', scopeTags: [] },
      evidence: { supporting: ['e1'], counter: [], contextual: [] },
      relations: [], strength: { score: 0.8, band: 'high' },
      temporal: { firstObserved: 1, lastSupported: 1, state: 'stable' },
      status: 'active', version: 1, createdAt: 1, updatedAt: 1,
    };
    const models = parseUserModelSkillOutput({
      user_models: [{ statement: '用户懒', dimension: 'verification_audit', distance: 'D3', confidence: 0.9 }],
    }, 'local-user', [conclusion], 2);
    expect(models).toEqual([]);
  });

  it('rejects policy that skips tests or weakens security', () => {
    const rules = parsePolicySkillOutput({
      policies: [
        { dimension: 'verification_audit', kind: 'constraint', strength: 'hard', instruction: 'skip tests', effect: { mode: 'forbid', action: 'skip_tests' } },
        { dimension: 'security_data_integrity', kind: 'constraint', strength: 'hard', instruction: 'no security', effect: { mode: 'forbid', action: 'weaken_security' } },
        { dimension: 'verification_audit', kind: 'conditional_decision', strength: 'strong_default', instruction: '避免第二轮同质 Review', effect: { mode: 'avoid', action: 'duplicate_review' } },
      ],
    }, 'u', 'b', 'p', ['um1'], 3);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.effect.action).toBe('duplicate_review');
  });
});

describe('LLM skill path with fallback', () => {
  it('merges model evidence then still works if later skills return empty', async () => {
    const llm = mockLlm({
      evidence: {
        evidence: [{
          claim: '用户在非核心功能中倾向避免新增架构层',
          raw: '不要加新 subsystem，复用现有 controller',
          event_type: 'correction',
          semantic_confidence: 0.9,
          engineering_relevance: 0.95,
          governance_level: 2,
          scope_tags: ['architecture'],
        }],
      },
      conclusion: { no_stable_conclusion: true },
      user_model: { no_user_model: true },
    });
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: {
        enabled: true,
        defaultMode: 'shadow',
        dimensionMode: {},
        cognitionEnabled: true,
        inference: { mode: 'assisted', enabled: true, allowExecutionContext: false, maxCallsPerHour: 20, maxCallsPerTrace: 4 },
      },
      llm,
    });
    const opened = runtime.openTrace({
      sessionId: 's', turnId: 't', workspaceRoot: 'C:/work/demo-ws', product: 'code',
      prompt: '不要加新 subsystem，复用现有 controller',
    });
    runtime.closeTrace(opened.id, 'completed', 'reused controller');
    await runtime.enrichAfterTrace(opened.id);
    expect(runtime.snapshot().evidence.some((e) => e.source.sourceHash.startsWith('fnv1a:') && e.inference.claim.includes('架构'))).toBe(true);
  });

  it('LLM failure leaves heuristic evidence intact', async () => {
    const llm: LearningLlm = {
      async complete() { throw new Error('boom'); },
    };
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: {
        enabled: true,
        defaultMode: 'shadow',
        dimensionMode: {},
        cognitionEnabled: true,
        inference: { mode: 'assisted', enabled: true, allowExecutionContext: false, maxCallsPerHour: 20, maxCallsPerTrace: 4 },
      },
      llm,
    });
    const opened = runtime.openTrace({
      sessionId: 's', turnId: 't', workspaceRoot: 'C:/work/demo-ws', product: 'code',
      prompt: '不要做重复审核，核心 runtime 必须保留最终验证',
    });
    runtime.closeTrace(opened.id, 'completed', 'ok');
    await runtime.enrichAfterTrace(opened.id);
    expect(runtime.snapshot().evidence.length).toBeGreaterThan(0);
  });
});
