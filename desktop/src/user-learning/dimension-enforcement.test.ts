import { describe, expect, it } from 'vitest';
import { memoryRuntime, model, partition } from './hardening-fixtures';
import { compilePolicies } from './policy';
import { emptySnapshot } from './store';

describe('UL-P1-04 per-dimension / per-rule enforcement', () => {
  it('default shadow + verification enforced injects only verification', () => {
    const globalScope = { workspaceId: 'ws', projectId: 'global', scopeTags: ['code'] as const, product: 'code' as const };
    const verify = model({ id: 'um_v', dimension: 'verification_audit', scope: globalScope });
    const report = model({
      id: 'um_r',
      dimension: 'reporting_information_density',
      statement: '在执行类任务中，用户对低信息密度的过程性叙述接受度较低。',
      scope: globalScope,
    });
    const plan = model({
      id: 'um_p',
      dimension: 'planning_direct_execution',
      statement: '对低风险、局部、可回滚任务，用户偏好 Agent 直接执行。',
      scope: globalScope,
    });
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [verify, report, plan] }, null, 5);
    const runtime = memoryRuntime({
      defaultMode: 'shadow',
      dimensionMode: {
        verification_audit: 'enforced',
        reporting_information_density: 'shadow',
        planning_direct_execution: 'off',
      },
    });
    runtime.seedFixture({
      userModels: [verify, report, plan],
      policyRules: compiled.rules,
      policyBundles: [compiled.bundle],
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '改设置页按钮文案',
      baseSystemPrompt: '',
    });
    const parts = partition(prepared.decision);
    expect(parts.enforced.length).toBeGreaterThan(0);
    expect(parts.enforced.every((rule) => rule.domain === 'verification_audit')).toBe(true);
    expect(parts.shadow.some((rule) => rule.domain === 'reporting_information_density')).toBe(true);
    expect(parts.off.some((rule) => rule.domain === 'planning_direct_execution')).toBe(true);
    expect(prepared.decision.injected).toBe(true);
    expect(prepared.decision.injectionText).toMatch(/trylo_active_engineering_policy/);
    expect(prepared.decision.injectionText).not.toMatch(/叙述|汇报|直接执行/);
  });

  it('default enforced + reporting off keeps reporting out of the prompt', () => {
    const globalScope = { workspaceId: 'ws', projectId: 'global', scopeTags: ['code'] as const, product: 'code' as const };
    const verify = model({ id: 'um_v', dimension: 'verification_audit', scope: globalScope });
    const report = model({
      id: 'um_r',
      dimension: 'reporting_information_density',
      statement: '在执行类任务中，用户对低信息密度的过程性叙述接受度较低。',
      scope: globalScope,
    });
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [verify, report] }, null, 5);
    const runtime = memoryRuntime({
      defaultMode: 'enforced',
      dimensionMode: { reporting_information_density: 'off' },
    });
    runtime.seedFixture({
      userModels: [verify, report],
      policyRules: compiled.rules,
      policyBundles: [compiled.bundle],
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '改设置页按钮文案',
      baseSystemPrompt: '',
    });
    expect(prepared.decision.injectionText).not.toMatch(/叙述|汇报/);
    const parts = partition(prepared.decision);
    expect(parts.off.some((rule) => rule.domain === 'reporting_information_density')).toBe(true);
    expect(parts.enforced.some((rule) => rule.domain === 'reporting_information_density')).toBe(false);
  });
});
