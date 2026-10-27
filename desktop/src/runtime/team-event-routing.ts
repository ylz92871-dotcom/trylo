import { applyTeamEvents, type TeamEventExtras, type TeamProjectionContext } from '../surfaces/team/team-projection';
import type { TeamRun } from '../surfaces/team/team-types';
import { selectRunForConversation, teamRunsSnapshot, teamWorkspaceIdentity, toPersistableTeamRun, upsertTeamRun } from '../user-learning/team-access/profiles/team-runs-cache';
import type { PersistableTeamRun } from '../user-learning/team-access/persist';

export function teamRunForContext(ctx: TeamProjectionContext): PersistableTeamRun | null {
  const runs = teamRunsSnapshot(ctx.workspaceId);
  return ctx.teamRunId === undefined ? selectRunForConversation(runs, ctx.personConversationId)
    : runs.find(run => run.id === ctx.teamRunId && run.personConversationId === ctx.personConversationId) ?? null;
}

export function failTeamStart(ctx: TeamProjectionContext, message: string, now: number): TeamRun | null {
  return routeTeamEvents(ctx, [{ type: 'loop_end', reason: 'startup_failed', isError: true, error: message, ts: now }]);
}

/** Origin cache owns events even while a different conversation is on screen. */
export function routeTeamEvents(ctx: TeamProjectionContext, events: readonly unknown[], extras?: TeamEventExtras): TeamRun | null {
  const stored = teamRunForContext(ctx);
  if (!stored?.frozenProfile) return null;
  const workspaceId = teamWorkspaceIdentity(ctx.workspaceId) ?? ctx.workspaceId;
  const run = { ...stored, workspaceId, selectedSeatId: null } as TeamRun;
  const next = applyTeamEvents(run, events, { ...ctx, workspaceId }, extras);
  if (next && next !== run) void upsertTeamRun(toPersistableTeamRun(next), ctx.workspaceId);
  return next;
}

/** Selection is UI state; execution facts come from the origin projection. */
export function mergeTeamProjection(current: TeamRun | null, projected: TeamRun | null): TeamRun | null {
  if (!current || !projected || current.workspaceId !== projected.workspaceId || current.id !== projected.id) return current;
  const selected = current.seats.find(seat => seat.id === current.selectedSeatId);
  const selectedSeatId = projected.seats.find(seat => seat.id === selected?.id)?.id
    ?? (selected?.memberId ? projected.seats.find(seat => seat.memberId === selected.memberId)?.id : null) ?? null;
  return { ...projected, selectedSeatId };
}
