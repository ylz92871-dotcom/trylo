// Team spawn scorer tests (PR-3, spec §7.4 / §7.5 / §10.1 / §26).
//
// Run with: npx vitest run src/user-learning/team-access/spawn-score.test.ts

import { describe, expect, it } from 'vitest';
import {
  hasUnknownDecisions,
  hasVagueTaste,
  requirePersonSeat,
  scoreTeamSpawn,
} from './spawn-score';
import type { TaskContext } from '../types';

function task(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    product: 'code',
    taskType: 'implementation',
    risk: 'medium',
    corePath: false,
    reversible: true,
    components: [],
    changeType: 'feature',
    explicitInstruction: '',
    prompt: '实现一个新的导出模块，涉及多个文件',
    ...overrides,
  };
}

const ENABLED = { teamAccessEnabled: true, recentlyAsked: false };

describe('requirePersonSeat (spec §10.1 — 组队必有 Person seat)', () => {
  it('returns true whenever formingTeam, regardless of other inputs', () => {
    const base = {
      task: task(),
      inferred: [],
      unknownDecisions: false,
      vagueTaste: false,
    };
    expect(requirePersonSeat({ ...base, formingTeam: true })).toBe(true);
    expect(requirePersonSeat({ ...base, inferred: [{ confidence: 0.9, uncertainty: 'low' }], unknownDecisions: true, vagueTaste: true, formingTeam: true })).toBe(true);
  });

  it('returns false when not forming a team (solo keeps authority in Personal Agent)', () => {
    expect(requirePersonSeat({ task: task(), inferred: [], unknownDecisions: true, vagueTaste: true, formingTeam: false })).toBe(false);
  });
});

describe('scoreTeamSpawn', () => {
  it('flag off → stay_solo with empty seats, flag-independent of task shape', () => {
    for (const t of [task({ risk: 'low', prompt: 'typo' }), task({ corePath: true, risk: 'high', reversible: false })]) {
      const d = scoreTeamSpawn({ task: t, teamAccessEnabled: false, recentlyAsked: false });
      expect(d.decision).toBe('stay_solo');
      expect(d.recommendedSeats).toEqual([]);
      expect(d.requirePersonSeat).toBe(false);
    }
  });

  it('confirmedSpawn short-circuits to spawn_team, never re-asks', () => {
    const d = scoreTeamSpawn({
      task: task({ corePath: true, risk: 'high', reversible: false }),
      ...ENABLED,
      confirmedSpawn: true,
      recentlyAsked: true,
    });
    expect(d.decision).toBe('spawn_team');
    expect(d.requirePersonSeat).toBe(true);
    expect(d.recommendedSeats[0]).toBe('person');
  });

  it('destructive prompt asking to skip verification → refuse', () => {
    const d = scoreTeamSpawn({
      task: task({ prompt: 'rm -rf 旧目录，然后跳过验证直接交付', risk: 'high', reversible: false }),
      ...ENABLED,
    });
    expect(d.decision).toBe('refuse');
    expect(d.refuseCode).toBe('safety');
    expect(d.recommendedSeats).toEqual([]);
  });

  it('low-risk 1-2 file localized change → stay_solo', () => {
    const d = scoreTeamSpawn({
      task: task({ risk: 'low', prompt: '修一个 typo，改这一个文件' }),
      ...ENABLED,
    });
    expect(d.decision).toBe('stay_solo');
    expect(d.requirePersonSeat).toBe(false);
  });

  it('high-impact + high uncertainty + not recently asked → stay_solo, never ask_user (Foundation spec §7.2)', () => {
    const d = scoreTeamSpawn({
      task: task({ corePath: true, risk: 'high', reversible: false }),
      ...ENABLED,
      inferred: [{ confidence: 0.9, uncertainty: 'high' }],
    });
    expect(d.decision).toBe('stay_solo');
    expect(d.decision).not.toBe('ask_user');
    expect(d.recommendedSeats).toEqual([]);
  });

  it('high-impact but recentlyAsked (6h window) → stay_solo', () => {
    const d = scoreTeamSpawn({
      task: task({ corePath: true, risk: 'high', reversible: false }),
      ...ENABLED,
      recentlyAsked: true,
      inferred: [{ confidence: 0.9, uncertainty: 'high' }],
    });
    expect(d.decision).toBe('stay_solo');
    expect(d.decision).not.toBe('ask_user');
  });

  it('medium-complexity multi-file task → stay_solo (Foundation spec §8.3 lock)', () => {
    const d = scoreTeamSpawn({ task: task(), ...ENABLED });
    expect(d.decision).toBe('stay_solo');
    expect(d.decision).not.toBe('ask_user');
    expect(d.requirePersonSeat).toBe(false);
    expect(d.recommendedSeats).toEqual([]);
  });

  it('architecture-heavy path → stay_solo; assembling a team is a manual Team-surface action', () => {
    const d = scoreTeamSpawn({
      task: task({ corePath: true, risk: 'high', prompt: '整体架构重构，跨模块迁移' }),
      ...ENABLED,
    });
    expect(d.decision).toBe('stay_solo');
  });

  it('irreversible + stub preference uncertainty high → still stay_solo, never ask_user', () => {
    const d = scoreTeamSpawn({
      task: task({ reversible: false, risk: 'medium' }),
      ...ENABLED,
      preference: {
        ranking: [{ id: 'team_full', probability: 0.9 }],
        uncertainty: 'high',
        scopeFit: 'high',
        relevantObservations: 3,
        source: 'stub_symbolic',
      },
    });
    expect(d.decision).toBe('stay_solo');
    expect(d.decision).not.toBe('ask_user');
  });

  it('work product with deliverable wording → stay_solo without confirmedSpawn', () => {
    const d = scoreTeamSpawn({
      task: task({ product: 'work', prompt: '把季度数据整理成 pptx 报告' }),
      ...ENABLED,
    });
    expect(d.decision).toBe('stay_solo');
  });

  it('WITHOUT confirmedSpawn, no task shape ever yields ask_user or spawn_team (§0 rule 1 matrix)', () => {
    const shapes: TaskContext[] = [
      task({ risk: 'low', prompt: '修一个 typo' }),
      task(),
      task({ corePath: true }),
      task({ risk: 'high' }),
      task({ reversible: false }),
      task({ corePath: true, risk: 'high', reversible: false }),
      task({ product: 'work', prompt: '跨模块整理季度 pptx 报告' }),
    ];
    for (const t of shapes) {
      for (const recentlyAsked of [false, true]) {
        const d = scoreTeamSpawn({ task: t, ...ENABLED, recentlyAsked });
        expect(['stay_solo', 'refuse']).toContain(d.decision);
        expect(d.decision).not.toBe('ask_user');
        expect(d.decision).not.toBe('spawn_team');
      }
    }
  });
});

describe('prompt signal helpers', () => {
  it('flags vague taste phrases', () => {
    expect(hasVagueTaste('界面简单点，别搞太复杂')).toBe(true);
    expect(hasVagueTaste('实现导出函数')).toBe(false);
  });

  it('flags missing acceptance on code but not product shape on work', () => {
    expect(hasUnknownDecisions('帮我实现这个功能', 'code')).toBe(true);
    expect(hasUnknownDecisions('验收标准是导出成功', 'code')).toBe(false);
    expect(hasUnknownDecisions('把数据整理成 xlsx', 'work')).toBe(false);
    expect(hasUnknownDecisions('整理一下这些资料', 'work')).toBe(true);
  });
});
