import { describe, expect, it } from 'vitest';
import { cognitionPromptMessage, formatPolicyAction, learningImpactMessage } from './ui-messages';
import type { CognitionSession, PolicyDecision } from './types';

describe('User Learning stream messages', () => {
  it('formats policy actions for the Impact card', () => {
    expect(formatPolicyAction('require:final_verification')).toBe('保留最终验证');
    expect(formatPolicyAction('prefer:direct_execution')).toBe('低风险直接执行');
  });

  it('builds a pending Cognition card from a session', () => {
    const session: CognitionSession = {
      id: 'cog_1',
      userId: 'local',
      trigger: 'bootstrap_optional',
      dimension: 'agent_autonomy',
      questions: [{
        id: 'q_bootstrap',
        dimension: 'agent_autonomy',
        trigger: 'bootstrap_optional',
        prompt: '普通功能和核心架构要求是否不同？',
        options: ['普通功能直接做；核心先计划并保留最终验证'],
        scopeHint: 'bootstrap',
      }],
      answers: [],
      status: 'open',
      evidenceIds: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const card = cognitionPromptMessage(session);
    expect(card.kind).toBe('cognition_prompt');
    expect(card.status).toBe('pending');
    expect(card.prompt).toMatch(/核心架构/);
    expect(card.options).toHaveLength(1);
  });

  it('only builds an Impact card when the user must confirm', () => {
    const base = {
      id: 'pd_1',
      userId: 'local',
      projectId: 'p',
      taskId: 't',
      bundleVersion: 1,
      contextHash: 'h',
      matchedRuleIds: [],
      suppressedRuleIds: [],
      resolvedActions: ['prefer:direct_execution'],
      appliedCommitmentIds: [],
      opportunityKeys: [],
      active: [],
      enforced: [],
      shadow: [],
      off: [],
      suppressed: [],
      injectionText: '',
      tokenCountEstimate: 0,
      clarificationRequired: false,
      conflicts: [],
      mode: 'enforced',
      injected: true,
      resolveLatencyMs: 1,
      createdAt: 1,
    } as PolicyDecision;
    expect(learningImpactMessage(base)).toBeNull();
    const card = learningImpactMessage({
      ...base,
      clarificationRequired: true,
      impactCheck: {
        triggered: true,
        interruptUser: true,
        reason: 'would drop verification',
        suppressedActions: ['require:final_verification'],
        baselineActions: ['require:final_verification'],
      },
    });
    expect(card?.kind).toBe('learning_impact');
    expect(card?.baseline).toContain('保留最终验证');
  });
});
