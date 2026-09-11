import { describe, expect, it } from 'vitest';
import { model } from './hardening-fixtures';
import { compilePolicies, resolvePolicies } from './policy';
import { emptySnapshot } from './store';
import { classifyTaskContext } from './task-context';
import type { PolicyRule } from './types';

describe('UL-P1-08 / current bundle only', () => {
  it('resolver ignores leftover active rules that the current bundle does not reference', () => {
    const um = model();
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [um] }, null, 10);
    const stale: PolicyRule = {
      ...compiled.rules[0]!,
      id: 'pol_stale_active',
      bundleId: 'pb_old',
      instruction: 'STALE RULE MUST NEVER MATCH',
      effect: { mode: 'prefer', action: 'stale_unique_action' },
      when: [],
      scope: { product: 'code' },
      status: 'active',
      createdAt: 1,
    };
    const snap = {
      ...emptySnapshot(),
      userModels: [um],
      policyRules: [...compiled.rules, stale],
      policyBundles: [
        { ...compiled.bundle, id: 'pb_old', status: 'active' as const, ruleIds: [stale.id], createdAt: 1 },
        compiled.bundle,
      ],
    };
    const decision = resolvePolicies({
      snapshot: snap,
      task: classifyTaskContext({ prompt: '改设置页按钮文案', product: 'code' }),
      projectId: 'p',
      mode: 'enforced',
    });
    expect(decision.matchedRuleIds).not.toContain('pol_stale_active');
    expect(decision.active.some((rule) => rule.policyId === 'pol_stale_active')).toBe(false);
    expect(decision.injectionText).not.toMatch(/STALE RULE/);
  });
});
