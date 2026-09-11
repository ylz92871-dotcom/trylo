// Composer draft module singleton (Foundation spec §10.4 / Pitfall 18).
//
// The composer's state does NOT live in React or in App.tsx: flipping
// CollaborationSwitch away unmounts the Team surface, and the draft
// must survive. Re-entering Team with no run re-opens THIS draft; with
// a live run the run view wins. Non-React, no fs.
//
// Mutations bump a version so TeamSurface can subscribe via
// useSyncExternalStore — writing the singleton without a tick left the
// goal input / roster stuck on the last render.

import type { ComposerDraft } from './composer-store';
import { draftFromProfile } from './composer-store';
import type { TeamProfile } from '../team-profile-types';

export interface ComposerSnapshot {
  readonly draft: ComposerDraft | null;
  readonly launchError: string | null;
}

let draft: ComposerDraft | null = null;
let launchError: string | null = null;
/** Terminal run the user dismissed with 「新团队」; survives remount. */
let dismissedRunId: string | null = null;
let snapshot: ComposerSnapshot = { draft: null, launchError: null };
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { draft, launchError };
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getComposerSnapshot(): ComposerSnapshot {
  return snapshot;
}

export function composerDraftVersion(): number {
  return version;
}

export function getComposerDraft(): ComposerDraft | null {
  return draft;
}

export function setComposerDraft(next: ComposerDraft | null): void {
  draft = next;
  launchError = null;
  emit();
}

export function setComposerLaunchError(message: string | null): void {
  launchError = message;
  emit();
}

export function getComposerLaunchError(): string | null {
  return launchError;
}

/** Open the composer from a template / saved profile click. */
export function openComposerWithProfile(profile: TeamProfile, goal?: string): ComposerDraft {
  draft = draftFromProfile(profile, goal && goal.trim() ? { goal: goal.trim().slice(0, 240) } : {});
  launchError = null;
  emit();
  return draft;
}

/** 「让 Person 建议一组」: seed from the mapped template + last Person prompt. */
export function seedComposerDraft(profile: TeamProfile, goal?: string): ComposerDraft {
  draft = draftFromProfile(profile, goal && goal.trim() ? { goal: goal.trim().slice(0, 240) } : {});
  launchError = null;
  emit();
  return draft;
}

export function clearComposerDraft(): void {
  draft = null;
  launchError = null;
  emit();
}

export function hasComposerDraft(): boolean {
  return draft !== null;
}

export function dismissTeamRun(runId: string): void {
  dismissedRunId = runId;
}

export function isTeamRunDismissed(runId: string): boolean {
  return dismissedRunId === runId;
}

export function clearDismissedTeamRun(): void {
  dismissedRunId = null;
}

/** Test isolation: wipe the singleton between cases. */
export function resetComposerDraftForTests(): void {
  draft = null;
  launchError = null;
  dismissedRunId = null;
  snapshot = { draft: null, launchError: null };
  version += 1;
  for (const listener of listeners) listener();
}
