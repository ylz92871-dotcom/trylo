import { describe, expect, it } from 'vitest';
import {
  applySeatPatch,
  appendSeat,
  emptyTeamRun,
  findSeat,
  isTeamRunActive,
  selectSeat,
  summarizeTeam,
} from './team-store';
import { FIXTURE_TEAM_RUN } from './team-fixture';
import { FIXTURE_FROZEN_PROFILE } from './team-fixture';
import type { SeatInstance, TaskSummary } from './team-types';

const FROZEN_PROFILE = FIXTURE_FROZEN_PROFILE;

const SAMPLE_SUMMARY: TaskSummary = {
  title: '做 X',
  goal: '把 X 做完',
  oneLiner: '把 X 做完。',
};

function makeRun(): ReturnType<typeof emptyTeamRun> {
  return emptyTeamRun({
    id: 'r1',
    workspaceId: 'w1',
    personConversationId: 'c1',
    summary: SAMPLE_SUMMARY,
    frozenProfile: FROZEN_PROFILE,
    seats: [
      { id: 's-w', seat: 'worker', status: 'running', summary: '改文件' },
      { id: 's-r', seat: 'reviewer', status: 'queued', summary: '排队' },
    ],
  });
}

describe('surfaces/team/team-store', () => {
  it('orders seats into roster order on create', () => {
    const run = emptyTeamRun({
      id: 'r',
      workspaceId: 'w',
      personConversationId: 'c',
      summary: SAMPLE_SUMMARY,
      frozenProfile: FROZEN_PROFILE,
      seats: [
        { id: 's-r', seat: 'reviewer', status: 'queued', summary: 'r' },
        { id: 's-w', seat: 'worker', status: 'running', summary: 'w' },
        { id: 's-p', seat: 'person', status: 'completed', summary: 'p' },
      ],
    });
    expect(run.seats.map(s => s.seat)).toEqual(['person', 'worker', 'reviewer']);
  });

  it('selectSeat round-trips and drops selection for off-stage seats', () => {
    const run = makeRun();
    const withSelected = selectSeat(run, 's-w');
    expect(withSelected.selectedSeatId).toBe('s-w');
    expect(selectSeat(withSelected, null).selectedSeatId).toBeNull();
    // Off-stage seat id → selection cleared (back to summary board).
    const cleared = selectSeat(withSelected, 's-ghost');
    expect(cleared.selectedSeatId).toBeNull();
  });

  it('applySeatPatch updates a seat and bumps updatedAt', () => {
    const run = makeRun();
    const next = applySeatPatch(run, 's-w', { status: 'completed', result: 'done' });
    const updated = findSeat(next, 's-w');
    expect(updated?.status).toBe('completed');
    expect(updated?.result).toBe('done');
    expect(next.updatedAt).toBeGreaterThanOrEqual(run.updatedAt);
  });

  it('applySeatPatch is a no-op for unknown seat ids', () => {
    const run = makeRun();
    const next = applySeatPatch(run, 's-nope', { status: 'failed' });
    expect(next).toBe(run);
  });

  it('sort keeps two seats of the same role instead of collapsing them', () => {
    const run = emptyTeamRun({
      id: 'r',
      workspaceId: 'w',
      personConversationId: 'c',
      summary: SAMPLE_SUMMARY,
      frozenProfile: FROZEN_PROFILE,
      seats: [
        { id: 's-w-1', seat: 'worker', status: 'running', summary: 'a' },
        { id: 's-r', seat: 'reviewer', status: 'queued', summary: 'r' },
        { id: 's-w-2', seat: 'worker', status: 'queued', summary: 'b' },
      ],
    });
    expect(run.seats.map(s => s.id)).toEqual(['s-w-1', 's-w-2', 's-r']);
  });

  it('appendSeat adds a seat and respects roster order', () => {
    const run = makeRun();
    const reviewer: SeatInstance = {
      id: 's-a',
      seat: 'architect',
      status: 'queued',
      summary: '方案',
    };
    const next = appendSeat(run, reviewer);
    expect(next.seats.map(s => s.seat)).toEqual(['architect', 'worker', 'reviewer']);
    // Idempotent: re-appending same id is a no-op.
    const again = appendSeat(next, reviewer);
    expect(again).toBe(next);
  });

  it('summarizeTeam counts statuses correctly', () => {
    const run = FIXTURE_TEAM_RUN;
    const stats = summarizeTeam(run);
    expect(stats).toEqual({
      running: 1,
      waiting: 0,
      queued: 1,
      done: 1,
      failed: 0,
      total: 3,
    });
  });

  it('isTeamRunActive handles missing / terminal runs', () => {
    expect(isTeamRunActive(null)).toBe(false);
    expect(isTeamRunActive(undefined)).toBe(false);
    expect(isTeamRunActive({ ...FIXTURE_TEAM_RUN, status: 'completed' })).toBe(false);
    expect(isTeamRunActive(FIXTURE_TEAM_RUN)).toBe(true);
  });
});
