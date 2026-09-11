/**
 * The single public entry point for the Person / Team surface
 * subsystem. App.tsx imports from here only — never from the inner
 * team/ or person/ subfolders. Spec §3.
 */
export type { CollaborationSurface } from './types';
export type {
  TeamRoleId,
  TeamMemberId,
  TryloTeamSeatId,
  SeatRunStatus,
  TeamRunStatus,
  TaskSummary,
  SeatInstance,
  TeamRun,
  TeamSummaryStats,
} from './team/team-types';
export { SurfaceHost } from './SurfaceHost';
export { CollaborationSwitch } from './CollaborationSwitch';
export { PersonTeamStatusBar, PersonTeamComposeHint } from './person/PersonTeamStatusBar';
export { TeamSurface } from './team/TeamSurface';
export {
  emptyTeamRun,
  selectSeat,
  applySeatPatch,
  appendSeat,
  summarizeTeam,
  isTeamRunActive,
  findSeat,
} from './team/team-store';
// FIXTURE_TEAM_RUN is intentionally NOT re-exported here (Foundation spec
// §10.10): the fixture is test-only, imported by unit tests directly from
// ./team/team-fixture.
export { applyTeamEvents, cancelTeamSeat } from './team/team-projection';
// Composer glue App needs (App imports surfaces only — spec §3):
export {
  openComposerWithProfile,
  getComposerDraft,
  clearComposerDraft,
  seedComposerDraft,
  setComposerLaunchError,
  clearDismissedTeamRun,
} from './team/composer/composer-draft';
export { teamModelChoices } from './team/composer/composer-store';
export type { TeamProfile } from './team/team-profile-types';
