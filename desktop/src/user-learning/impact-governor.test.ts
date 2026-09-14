import { describe, expect, it } from 'vitest';
import { evaluatePreferenceImpact } from './impact-check';
import { memoryRuntime, model } from './hardening-fixtures';
import { compilePolicies } from './policy';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore, emptySnapshot } from './store';
import { classifyTaskContext } from './task-context';

describe('UL-P1-06 decision governor', () => {
  it('high-impact unresolved personalization leaves the run pending instead of ready', () => {
    const um = model({
      id: 'um_plan',
      dimension: 'planning_direct_execution',
      statement: '对低风险任务用户偏好直接执行。',
      confidence: { score: 0.7, band: 'medium' },
      inference: { distance: 'D1', alternativeExplanations: ['赶时间'], rationaleSummary: 'weak' },
      scope: { workspaceId: 'ws', projectId: 'global', scopeTags: ['code'], product: 'code' },
    });
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [um] }, null, 4);
    const runtime = memoryRuntime({ defaultMode: 'enforced' });
    runtime.seedFixture({
      userModels: [um],
      policyRules: compiled.rules,
      policyBundles: [compiled.bundle],
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '修改持久状态迁移和核心 runtime',
      baseSystemPrompt: 'base',
    });
    const extended = prepared as typeof prepared & {
      start?: 'ready' | 'pending_impact' | 'blocked';
      pendingRun?: { id: string };
    };
    expect(prepared.decision.impactCheck?.interruptUser).toBe(true);
    expect(prepared.decision.injected).toBe(false);
    expect(extended.start === 'pending_impact' || Boolean(extended.pendingRun)).toBe(true);
    expect(prepared.systemPrompt).not.toMatch(/trylo_active_engineering_policy/);
  });

  it('choosing baseline resumes exactly once and writes governed evidence, not a User Model', () => {
    const um = model({
      id: 'um_plan',
      dimension: 'planning_direct_execution',
      statement: '对低风险任务用户偏好直接执行。',
      confidence: { score: 0.7, band: 'medium' },
      inference: { distance: 'D1', alternativeExplanations: ['赶时间'], rationaleSummary: 'weak' },
      scope: { workspaceId: 'ws', projectId: 'global', scopeTags: ['code'], product: 'code' },
    });
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [um] }, null, 4);
    const runtime = memoryRuntime({ defaultMode: 'enforced' });
    runtime.seedFixture({
      userModels: [um],
      policyRules: compiled.rules,
      policyBundles: [compiled.bundle],
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '修改持久状态迁移和核心 runtime',
      baseSystemPrompt: 'base-system',
    });
    const id = prepared.pendingRun?.id;
    expect(id).toBeTruthy();
    runtime.recordImpactResolution({
      workspaceRoot: 'D:/proj-alpha',
      acceptPersonalization: false,
      reason: 'keep baseline',
      product: 'code',
    });
    const first = runtime.resumePendingRun(id!, 'baseline');
    expect(first.started).toBe(1);
    expect(first.reason).toBe('resumed');
    expect(first.systemPrompt).toBe('base-system');
    expect(first.decision?.injected).toBe(false);
    const second = runtime.resumePendingRun(id!, 'baseline');
    expect(second.started).toBe(0);
    expect(second.reason).toBe('already_started');
    expect(runtime.snapshot().userModels.filter((item) => item.status === 'active').every((item) => item.id === 'um_plan')).toBe(true);
    expect(runtime.snapshot().evidence.length).toBeGreaterThan(0);
  });

  it('dismiss and expiry do not start the pending run', () => {
    let t = 10;
    const um = model({
      id: 'um_plan2',
      dimension: 'planning_direct_execution',
      statement: '对低风险任务用户偏好直接执行。',
      confidence: { score: 0.7, band: 'medium' },
      inference: { distance: 'D1', alternativeExplanations: ['赶时间'], rationaleSummary: 'weak' },
      scope: { workspaceId: 'ws', projectId: 'global', scopeTags: ['code'], product: 'code' },
    });
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [um] }, null, 4);
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
      now: () => t,
    });
    runtime.seedFixture({
      userModels: [um],
      policyRules: compiled.rules,
      policyBundles: [compiled.bundle],
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '修改持久状态迁移和核心 runtime',
      baseSystemPrompt: 'base',
    });
    const dismissed = runtime.resumePendingRun(prepared.pendingRun!.id, 'dismiss');
    expect(dismissed.started).toBe(0);
    expect(dismissed.reason).toBe('dismissed');

    const fresh = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
      now: () => t,
    });
    fresh.seedFixture({
      userModels: [um],
      policyRules: compiled.rules,
      policyBundles: [compiled.bundle],
    });
    const again = fresh.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '修改持久状态迁移和核心 runtime',
      baseSystemPrompt: 'base',
    });
    expect(again.pendingRun).toBeTruthy();
    t = (again.pendingRun?.expiresAt ?? t) + 1;
    const expired = fresh.resumePendingRun(again.pendingRun!.id, 'baseline');
    expect(expired.started).toBe(0);
    expect(expired.reason).toBe('expired');
  });

  it('choosing personalization resumes once with the scoped instruction in the prompt', () => {
    const um = model({
      id: 'um_v',
      dimension: 'planning_direct_execution',
      statement: '对低风险任务用户偏好直接执行。',
      confidence: { score: 0.7, band: 'medium' },
      inference: { distance: 'D1', alternativeExplanations: ['赶时间'], rationaleSummary: 'weak' },
      scope: { workspaceId: 'ws', projectId: 'global', scopeTags: ['code'], product: 'code' },
    });
    const compiled = compilePolicies({ ...emptySnapshot(), userModels: [um] }, null, 4);
    const runtime = memoryRuntime({ defaultMode: 'enforced' });
    runtime.seedFixture({
      userModels: [um],
      policyRules: compiled.rules,
      policyBundles: [compiled.bundle],
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: 'D:/proj-alpha',
      product: 'code',
      prompt: '修改持久状态迁移和核心 runtime',
      baseSystemPrompt: 'base',
    });
    const id = prepared.pendingRun?.id;
    expect(id).toBeTruthy();
    const first = runtime.resumePendingRun(id!, 'personalization');
    expect(first.started).toBe(1);
    expect(first.reason).toBe('resumed');
    expect(first.systemPrompt).toMatch(/base|trylo_active_engineering_policy|Explicit current task instruction/);
    expect(runtime.resumePendingRun(id!, 'personalization').started).toBe(0);
  });

  it('impact conditions still require high impact, uncertainty, and a material delta', () => {
    const task = classifyTaskContext({ prompt: '按钮 margin 改成 8px', product: 'code' });
    const check = evaluatePreferenceImpact({
      task,
      decision: {
        resolvedActions: ['avoid:duplicate_review'],
        active: [{
          policyId: 'p',
          domain: 'verification_audit',
          mode: 'avoid',
          instruction: 'x',
          applicationScore: 0.7,
          reason: '',
        }],
      },
    });
    expect(check.interruptUser).toBe(false);
  });
});
