import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import type { LearningLlm } from './llm';

describe('UL-P1-08 async revision compare-and-commit', () => {
  it('stale delayed policy LLM results cannot activate after a newer revision', async () => {
    let policyCalls = 0;
    let releaseStale: (() => void) | undefined;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const llm: LearningLlm = {
      async complete(skill) {
        if (skill === 'evidence') {
          return JSON.stringify({
            evidence: [{
              claim: '用户倾向减少重复、低收益的审核。',
              raw: '不要做重复审核',
              event_type: 'explicit_statement',
              semantic_confidence: 0.9,
              engineering_relevance: 0.9,
              governance_level: 2,
            }],
          });
        }
        if (skill === 'conclusion') {
          return JSON.stringify({
            conclusions: [{
              statement: '在中低风险任务中，用户倾向减少重复、同质审核。',
              dimension: 'verification_audit',
              supporting: [],
            }],
          });
        }
        if (skill === 'user_model') {
          return JSON.stringify({
            user_models: [{
              statement: '在中低风险 Coding 任务中，用户对重复、同质 Review 的容忍度较低。',
              dimension: 'verification_audit',
              distance: 'D0',
              confidence: 0.9,
            }],
          });
        }
        policyCalls += 1;
        const instruction = policyCalls === 1 ? 'STALE_ASYNC_POLICY' : 'FRESH_POLICY';
        if (policyCalls === 1) await staleGate;
        return JSON.stringify({
          policies: [{
            dimension: 'verification_audit',
            kind: 'conditional_decision',
            strength: 'strong_default',
            instruction,
            effect: { mode: 'avoid', action: 'duplicate_review' },
          }],
        });
      },
    };
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'shadow', dimensionMode: {}, cognitionEnabled: false },
      llm,
    });
    const first = runtime.openTrace({
      sessionId: 's1',
      turnId: 't1',
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '不要做重复审核',
    });
    runtime.closeTrace(first.id, 'completed', 'ok');
    const stale = runtime.enrichAfterTrace(first.id);
    const second = runtime.openTrace({
      sessionId: 's2',
      turnId: 't2',
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '不要做重复审核，核心 runtime 必须保留最终验证',
    });
    runtime.closeTrace(second.id, 'completed', 'ok2');
    await runtime.enrichAfterTrace(second.id);
    releaseStale?.();
    await stale;
    const instructions = runtime.snapshot().policyRules.map((rule) => rule.instruction);
    expect(instructions.some((text) => text.includes('STALE_ASYNC_POLICY'))).toBe(false);
  });
});
