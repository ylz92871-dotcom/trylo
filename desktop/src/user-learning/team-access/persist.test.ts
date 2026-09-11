// team-runs.json persistence tests (PR-11, spec §8.6).

import { describe, expect, it } from 'vitest';
import {
  MAX_TERMINAL_TEAM_RUNS,
  parseTeamRunsFile,
  serializeTeamRunsFile,
  teamRunsFilePath,
  type PersistableTeamRun,
} from './persist';

function run(overrides: Partial<PersistableTeamRun> = {}): PersistableTeamRun {
  return {
    id: 'team-conv-1',
    personConversationId: 'conv-1',
    status: 'running',
    summary: { title: '实现最小抽象', goal: 'g', oneLiner: 'o' },
    seats: [
      { id: 'p1', seat: 'person', status: 'running', summary: '实现导出模块' },
    ],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe('serializeTeamRunsFile / parseTeamRunsFile', () => {
  it('round-trips runs and never persists selectedSeatId', () => {
    const text = serializeTeamRunsFile('ws:abc', [
      run({ seats: [{ id: 'p1', seat: 'person', status: 'running', summary: 's' }] } as never),
    ]);
    // The serializer input is structural — selectedSeatId (if a caller
    // passes a full TeamRun) must not leak into the JSON.
    const parsed = parseTeamRunsFile(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(2);
    expect(parsed!.workspaceId).toBe('ws:abc');
    expect(parsed!.runs[0]!.id).toBe('team-conv-1');
    expect(text.includes('selectedSeatId')).toBe(false);
  });

  it('retention: newest non-terminal run plus at most 20 terminal runs', () => {
    const runs = [
      run({ id: 'active', status: 'waiting', updatedAt: 999 }),
      ...Array.from({ length: 30 }, (_, i) => run({
        id: `done-${i}`,
        status: 'completed' as const,
        updatedAt: 100 + i,
      })),
    ];
    const parsed = parseTeamRunsFile(serializeTeamRunsFile('ws', runs))!;
    expect(parsed.runs.length).toBe(MAX_TERMINAL_TEAM_RUNS + 1);
    expect(parsed.runs.some((r) => r.id === 'active')).toBe(true);
    // newest terminal kept (updatedAt 129)
    expect(parsed.runs.some((r) => r.id === 'done-29')).toBe(true);
    expect(parsed.runs.some((r) => r.id === 'done-0')).toBe(false);
  });

  it('malformed files fail closed to null', () => {
    expect(parseTeamRunsFile('nope')).toBeNull();
    expect(parseTeamRunsFile('{"schemaVersion":99,"workspaceId":"w","runs":[]}')).toBeNull();
    expect(parseTeamRunsFile('[]')).toBeNull();
  });

  it('path joins forward slashes under .trylo', () => {
    expect(teamRunsFilePath('D:/proj')).toBe('D:/proj/.trylo/team-runs.json');
    expect(teamRunsFilePath('D:\\proj\\')).toBe('D:/proj/.trylo/team-runs.json');
  });
});

describe('schemaVersion 1 | 2 (Foundation spec §9.2 / Pitfall 22)', () => {
  it('still parses v1 files and synthesizes legacy member ids + role display names', () => {
    const v1 = {
      schemaVersion: 1,
      workspaceId: 'ws',
      runs: [
        {
          id: 'team-conv-1',
          personConversationId: 'conv-1',
          status: 'completed',
          summary: { title: 'T', goal: 'g', oneLiner: 'o' },
          seats: [
            { id: 'p1', seat: 'person', status: 'completed', summary: 's' },
            { id: 'w9', seat: 'worker', status: 'completed', summary: 's' },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const parsed = parseTeamRunsFile(JSON.stringify(v1))!;
    expect(parsed).not.toBeNull();
    const seats = parsed.runs[0]!.seats;
    expect(seats[0]!.memberId).toBe('legacy-person-p1');
    expect(seats[0]!.displayName).toBe('Person');
    expect(seats[1]!.memberId).toBe('legacy-worker-w9');
    expect(seats[1]!.displayName).toBe('Worker');
  });

  it('accepts schemaVersion 2 and preserves explicit identity fields', () => {
    const v2 = {
      schemaVersion: 2,
      workspaceId: 'ws',
      runs: [
        {
          id: 'team-conv-2',
          personConversationId: 'conv-2',
          status: 'running',
          summary: { title: 'T', goal: 'g', oneLiner: 'o' },
          seats: [
            {
              id: 'queued:m1',
              memberId: 'm1',
              seat: 'worker',
              displayName: 'Worker · 文档',
              status: 'queued',
              summary: '',
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const parsed = parseTeamRunsFile(JSON.stringify(v2))!;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.runs[0]!.seats[0]!.memberId).toBe('m1');
    expect(parsed.runs[0]!.seats[0]!.displayName).toBe('Worker · 文档');
  });

  it('serialize writes schemaVersion 2 with the frozenProfile carried through', () => {
    const withProfile = run({
      frozenProfile: {
        schemaVersion: 1,
        id: 'team-conv-1',
        origin: 'custom',
        surface: 'code',
        title: 'T',
        createdAt: 1,
        updatedAt: 1,
        members: [
          { memberId: 'm1', baseRole: 'worker', displayName: 'Worker', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
        ],
      },
    });
    const text = serializeTeamRunsFile('ws', [withProfile]);
    const parsed = JSON.parse(text);
    expect(parsed['schemaVersion']).toBe(2);
    expect(parsed['runs'][0]['frozenProfile']['members']).toHaveLength(1);
  });
});
