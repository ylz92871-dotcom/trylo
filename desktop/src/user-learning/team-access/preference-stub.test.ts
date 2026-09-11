// Preference stub tests (PR-6, spec §12.2).

import { describe, expect, it } from 'vitest';
import { createSymbolicPreferenceScorer, spawnCandidates } from './preference-stub';
import type { TaskContext, UserLearningSnapshot } from '../types';

function task(prompt: string): TaskContext {
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

function snapshot(models: UserLearningSnapshot['userModels']): UserLearningSnapshot {
  return { userModels: models } as unknown as UserLearningSnapshot;
}

const scorer = createSymbolicPreferenceScorer();

describe('symbolic preference stub', () => {
  it('never claims uncertainty low, even with strong D0 anchors', () => {
    const s = scorer.score({
      task: task('验证这个新模块'),
      snapshot: snapshot([
        {
          id: 'um_1',
          status: 'active',
          dimension: 'verification_audit',
          confidence: { score: 0.95, band: 'high' },
          inference: { distance: 'D0' },
        } as never,
      ]),
      candidates: spawnCandidates(),
    });
    expect(s.uncertainty).toBe('medium');
    expect(s.uncertainty).not.toBe('low');
    expect(s.source).toBe('stub_symbolic');
  });

  it('no matching UMs → uncertainty high and uniform ranking', () => {
    const s = scorer.score({
      task: task('随便写个脚本'),
      snapshot: snapshot([]),
      candidates: spawnCandidates(),
    });
    expect(s.uncertainty).toBe('high');
    expect(s.relevantObservations).toBe(0);
    for (const r of s.ranking) {
      expect(r.probability).toBeCloseTo(0.25, 5);
    }
  });

  it('candidates with matching dimension factors rank higher', () => {
    const candidates = [
      { id: 'ask_user', label: 'ask', factors: { verification_audit: 0.2 } },
      { id: 'team_full', label: 'full', factors: { verification_audit: 0.9 } },
    ];
    const s = scorer.score({
      task: task('需要完整验证审核的改动'),
      snapshot: snapshot([
        {
          id: 'um_1',
          status: 'active',
          dimension: 'verification_audit',
          confidence: { score: 0.9, band: 'high' },
          inference: { distance: 'D0' },
        } as never,
      ]),
      candidates,
    });
    expect(s.ranking[0]!.id).toBe('team_full');
    expect(s.relevantObservations).toBe(1);
    const total = s.ranking.reduce((sum, r) => sum + r.probability, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('superseded UMs are ignored as observations', () => {
    const s = scorer.score({
      task: task('验证这个改动'),
      snapshot: snapshot([
        {
          id: 'um_1',
          status: 'superseded',
          dimension: 'verification_audit',
          confidence: { score: 0.9, band: 'high' },
          inference: { distance: 'D0' },
        } as never,
      ]),
      candidates: spawnCandidates(),
    });
    expect(s.relevantObservations).toBe(0);
  });

  it('a throwing snapshot degrades to uncertainty high instead of crashing', () => {
    const s = scorer.score({
      task: task('验证这个改动'),
      snapshot: {
        userModels: new Proxy([], {
          get() {
            throw new Error('boom');
          },
        }),
      } as unknown as UserLearningSnapshot,
      candidates: spawnCandidates(),
    });
    expect(s.uncertainty).toBe('high');
    expect(s.ranking).toHaveLength(4);
  });
});
