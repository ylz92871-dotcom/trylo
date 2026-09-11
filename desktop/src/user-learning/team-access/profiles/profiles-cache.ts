// TeamProfiles cache (Foundation spec §9.1).
//
// Module singleton over `.trylo/team-profiles.json` — the profiles
// counterpart of team-runs-cache. App loads on workspace switch and
// subscribes (useSyncExternalStore, NOT useState — Pitfall 9). IO is
// injected; no fs/React/Tauri in this module. Builtins live in code
// and are never stored here (profile-io filters them on parse).

import {
  canSaveCustomProfile,
  parseTeamProfilesFile,
  serializeTeamProfilesFile,
  teamProfilesFilePath,
} from './profile-io';
import type { TeamProfile } from './profile-types';

export interface TeamProfilesCacheIo {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, body: string) => Promise<void>;
}

let io: TeamProfilesCacheIo | null = null;
let state: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly profiles: readonly TeamProfile[];
} | null = null;
/** Bumped on every list mutation; the subscribe token for useSyncExternalStore. */
let version = 0;
const listeners = new Set<() => void>();
let loadSeq = 0;
/** Malformed profile file → idle hint; the file is never deleted (§10.9). */
let corrupted = false;

export function configureTeamProfilesCache(nextIo: TeamProfilesCacheIo | null): void {
  io = nextIo;
  state = null;
  corrupted = false;
  version += 1;
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeTeamProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot token for useSyncExternalStore (identity changes on mutation). */
export function teamProfilesVersion(): number {
  return version;
}

export function teamProfilesSnapshot(): readonly TeamProfile[] {
  return state?.profiles ?? [];
}

export function isTeamProfilesFileCorrupted(): boolean {
  return corrupted;
}

export async function loadTeamProfilesForWorkspace(
  workspaceRoot: string,
  workspaceId: string,
): Promise<void> {
  const seq = ++loadSeq;
  state = { workspaceRoot, workspaceId, profiles: [] };
  corrupted = false;
  if (!io) return;
  try {
    const text = await io.readFile(teamProfilesFilePath(workspaceRoot));
    if (seq !== loadSeq) return;
    const parsed = parseTeamProfilesFile(text);
    if (!parsed.ok) {
      corrupted = true;
      return;
    }
    state = { workspaceRoot, workspaceId, profiles: parsed.profiles };
    version += 1;
    emit();
  } catch {
    // No file yet (fresh workspace) — empty list.
  }
}

export async function upsertTeamProfile(profile: TeamProfile): Promise<void> {
  if (!state) return;
  const others = state.profiles.filter((p) => p.id !== profile.id);
  state = { ...state, profiles: [...others, profile] };
  version += 1;
  emit();
  await persist();
}

export async function removeTeamProfile(profileId: string): Promise<void> {
  if (!state) return;
  state = { ...state, profiles: state.profiles.filter((p) => p.id !== profileId) };
  version += 1;
  emit();
  await persist();
}

/** Save guard exposed for the composer's save-as flow. */
export function guardSave(profile: TeamProfile): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  return canSaveCustomProfile(state?.profiles ?? [], profile.id);
}

async function persist(): Promise<void> {
  if (!io || !state) return;
  try {
    await io.writeFile(
      teamProfilesFilePath(state.workspaceRoot),
      serializeTeamProfilesFile(state.workspaceId, state.profiles),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[team-access] team-profiles persist failed:', err);
  }
}
