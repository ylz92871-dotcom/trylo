// Team Translation tests (PR-4, spec §9 / §20.8).
//
// Golden: the same frontend-verification UM compiles OPPOSITE directions
// — the Personal Policy relieves the user of review, the Reviewer
// projection demands MORE review. Unknown dimensions emit nothing; hard
// baseline always survives; Shadow never yields injectable text.

import { describe, expect, it } from 'vitest';
import { compilePolicies, renderInjection } from '../policy';
import { fallbackContract } from './contract-compiler';
import { compileTeamTranslation } from './translation-compiler';
import { projectAllSeats, projectSeatTranslation } from './translation-resolve';
import type {
  TaskContext,
  UserModelRecord,
  UserLearningSnapshot,
} from '../types';

function snapshotWith(ums: UserLearningSnapshot['userModels']): UserLearningSnapshot {
  return {
    userId: 'local-user',
    userModels: ums,
    policyBundles: [],
    policyRules: [],
    projectContexts: [],
    traces: [],
    evidence: [],
    conclusions: [],
  } as unknown as UserLearningSnapshot;
}

function um(overrides: Partial<UserModelRecord> = {}): UserModelRecord {
  return {
    id: 'um_1',
    userId: 'local-user',
    statement: '用户无法可靠完成 frontend code-level verification',
    dimension: 'verification_audit',
    scope: { workspaceId: 'ws', projectId: 'p', scopeTags: ['code'] },
    confidence: { score: 0.82, band: 'high' },
    inference: { distance: 'D0', alternativeExplanations: ['用户只是赶时间'], rationaleSummary: 'restatement' },
    derivedFrom: { conclusionIds: ['con_1'] },
    profileDependencies: [],
    counterevidence: [],
    status: 'active',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function codeTask(prompt: string): TaskContext {
  return {
    product: 'code',
    taskType: 'implementation',
    risk: 'medium',
    corePath: false,
    reversible: true,
    components: [],
    changeType: 'implementation',
    explicitInstruction: '',
    prompt,
  };
}

function compileAll(snapshot: UserLearningSnapshot, product: 'code' | 'work' = 'code') {
  const contract = fallbackContract({
    prompt: '完成 frontend 校验流程',
    task: codeTask('完成 frontend 校验流程'),
    workspaceId: 'ws',
    projectId: 'proj:demo:1',
    personConversationId: 'conv',
  });
  return { contract, ...compileTeamTranslation({ snapshot, contract, product }) };
}

describe('compileTeamTranslation', () => {
  it('emits hard baseline for every seat surface regardless of User Model', () => {
    const { rules } = compileAll(snapshotWith([]));
    const text = rules.map((r) => r.instruction).join('\n');
    expect(text).toContain('instructed to pass');
    expect(text).toContain('Do not spawn agents');
    expect(text).toContain('不得削弱 safety');
    expect(rules.every((r) => r.strength === 'hard' || r.sourceUserModelIds.length > 0)).toBe(true);
  });

  it('Work adds the .trylo/out worker rule; Code does not', () => {
    const code = compileAll(snapshotWith([]), 'code').rules.map((r) => r.instruction).join('\n');
    const work = compileAll(snapshotWith([]), 'work').rules.map((r) => r.instruction).join('\n');
    expect(code).not.toContain('.trylo/out/');
    expect(work).toContain('.trylo/out/');
    expect(work).toContain('OfficeCLI');
  });

  it('only catalog dimensions compile; unknown dimensions emit zero personalized rules', () => {
    const snap = snapshotWith([
      um({ dimension: 'cost_time_quality' }),
      um({ id: 'um_2', dimension: 'git_change_management' }),
    ]);
    const { rules } = compileAll(snap);
    expect(rules.every((r) => r.strength === 'hard')).toBe(true);
  });

  it('verification_audit UM produces reviewer + person + worker personalized rules with source ids', () => {
    const { rules } = compileAll(snapshotWith([um()]));
    const personalized = rules.filter((r) => r.strength !== 'hard');
    expect(personalized.map((r) => r.effect.action).sort()).toEqual([
      'ask_user_code_review',
      'full_technical_review',
      'gold_plate_inferred',
    ]);
    for (const rule of personalized) {
      expect(rule.sourceUserModelIds).toEqual(['um_1']);
    }
  });

  it('superseded / disputed UMs never compile', () => {
    const { rules } = compileAll(snapshotWith([um({ status: 'superseded' })]));
    expect(rules.every((r) => r.strength === 'hard')).toBe(true);
  });
});

describe('golden: same UM, opposite directions (spec §9.1)', () => {
  const snap = snapshotWith([um()]);

  it('Personal side relieves the user; Reviewer projection demands full review', () => {
    // Personal Policy: compiled from the same UM through the existing
    // compiler — reduces the USER's review burden on low-risk paths.
    const { rules } = compilePolicies(snap, null, 10);
    const personalInjection = renderInjection(
      rules
        .filter((r) => r.domain === 'verification_audit')
        .map((r) => ({
          policyId: r.id,
          domain: r.domain,
          mode: r.effect.mode,
          instruction: r.instruction,
          applicationScore: 1,
          reason: 'golden',
        })),
    );
    expect(personalInjection).toContain('避免第二轮同目的 Review');

    // Team Translation: the Reviewer must NOT review less.
    const { rules: ttr } = compileAll(snap);
    const reviewer = projectSeatTranslation({ rules: ttr, seat: 'reviewer', mode: 'enforced' });
    const joined = reviewer.instructions.join('\n');
    expect(joined).toContain('完整技术审查');
    expect(joined).not.toContain('减少 review');
    expect(joined).not.toContain('避免第二轮');
    expect(joined).toContain('instructed to pass');
  });

  it('Person projection keeps the user out of code review while Reviewer reviews fully', () => {
    const { rules } = compileAll(snap);
    const person = projectSeatTranslation({ rules, seat: 'person', mode: 'enforced' });
    expect(person.instructions.join('\n')).toContain('不要把用户拉进 code-level review');
  });
});

describe('projectSeatTranslation / projectAllSeats', () => {
  const { rules } = compileAll(snapshotWith([um()]));

  it('shadow yields empty instructions with mode passthrough', () => {
    const p = projectSeatTranslation({ rules, seat: 'reviewer', mode: 'shadow' });
    expect(p.instructions).toEqual([]);
    expect(p.tokenCountEstimate).toBe(0);
    expect(p.mode).toBe('shadow');
    const all = projectAllSeats(rules, 'shadow');
    expect(Object.keys(all).sort()).toEqual(['architect', 'cad-planner', 'cad-verifier', 'person', 'reviewer', 'verifier', 'worker']);
    for (const projection of Object.values(all)) {
      expect(projection.instructions).toEqual([]);
    }
  });

  it('enforced merges team + seat rules, hard first, within the 250-token budget', () => {
    const reviewer = projectSeatTranslation({ rules, seat: 'reviewer', mode: 'enforced' });
    expect(reviewer.instructions.join('\n')).toContain('instructed to pass');
    expect(reviewer.instructions.every((i) => i.length > 0)).toBe(true);
    expect(reviewer.tokenCountEstimate).toBeLessThanOrEqual(250);
    const worker = projectSeatTranslation({ rules, seat: 'worker', mode: 'enforced' });
    // Code worker: no work_artifact_workflow hard rule.
    expect(worker.instructions.join('\n')).not.toContain('.trylo/out/');
    expect(worker.instructions.join('\n')).toContain('gold-plate');
  });

  it('rules for other seats do not leak into a seat projection', () => {
    const p = projectSeatTranslation({ rules, seat: 'verifier', mode: 'enforced' });
    expect(p.instructions.join('\n')).not.toContain('gold-plate');
    expect(p.instructions.join('\n')).not.toContain('完整技术审查');
    expect(p.instructions.join('\n')).toContain('User approval is not VERDICT: PASS');
  });
});
