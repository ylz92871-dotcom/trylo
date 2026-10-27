// Team runs cache (Foundation spec §9.3).
//
// Module singleton holding the FULL `.trylo/team-runs.json` state —
// never a React store, never App useState. App.tsx keeps its single
// `teamRun` projection but persists THROUGH this cache so a second
// conversation's run can no longer be wiped by `[currentRun]` writes
// (Pitfall 22). IO is injected (hostAdapter.fs at the App boundary);
// this module stays free of fs, Tauri, and React.
import {
  parseTeamRunsFile,
  serializeTeamRunsFile,
  teamRunsFilePath,
  type PersistableTeamRun,
} from '../persist';
import { isTeamRunOpen } from '../../../domain/team-run-lifecycle';
import { commitTeamRuns, sameTeamRun, type TeamRunsStorage, type TeamRunMutation } from './team-runs-persistence';

export type TeamHistoryMark = 'active' | 'past';

export interface TeamRunsCacheIo {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, body: string) => Promise<void>;
  readonly storage?: TeamRunsStorage;
}

interface CacheState {
  readonly workspaceRoot: string;
  workspaceId: string;
  runs: readonly PersistableTeamRun[];
  corrupted: boolean;
  loaded: boolean;
  loading: Promise<void> | null;
  diskRaw: string | null;
  mutationVersion: number;
  readonly pending: Map<string, TeamRunMutation>;
}

const workspaces = new Map<string, CacheState>();
let activeKey: string | null = null;
let io: TeamRunsCacheIo | null = null;
let generation = 0;
let version = 0;
const listeners = new Set<() => void>();
/** True when the last load hit unreadable JSON — idle shows a hint, the
 *  bad file is NEVER deleted (Foundation spec §9.3 / §10.9). */
const writes = new Map<string, Promise<void>>();

/** A caller may name the workspace root or its stable UI id. */
function cacheFor(workspace?: string): CacheState | undefined {
  if (workspace === undefined) return activeKey === null ? undefined : workspaces.get(activeKey);
  return workspaces.get(teamRunsFilePath(workspace))
    ?? [...workspaces.values()].find(cache => cache.workspaceId === workspace);
}

export function configureTeamRunsCache(nextIo: TeamRunsCacheIo | null): void {
  io = nextIo;
  workspaces.clear();
  activeKey = null;
  generation += 1;
  version += 1;
  emit();
}

/** Persistable projection of a UI run: strips UI-only fields
 *  (`selectedSeatId`) so they never reach disk (Pitfall 17). */
export function toPersistableTeamRun(
  run: PersistableTeamRun & { readonly selectedSeatId?: unknown; readonly recovery?: unknown; readonly workspaceId?: unknown },
): PersistableTeamRun {
  const clone: Record<string, unknown> = { ...run };
  delete clone.selectedSeatId;
  delete clone.recovery;
  delete clone.workspaceId;
  return clone as unknown as PersistableTeamRun;
}

/**
 * Load the full file for a workspace switch. Read failure or malformed
 * JSON ⇒ empty cache with `corrupted` flag; the file is not deleted.
 */
export async function loadTeamRunsForWorkspace(
  workspaceRoot: string,
  workspaceId: string,
  selection: 'active' | 'background' = 'active',
): Promise<void> {
  const key = teamRunsFilePath(workspaceRoot);
  const activate = selection === 'active' || activeKey === null;
  const switched = activate && activeKey !== key;
  if (activate) activeKey = key;
  let cache = workspaces.get(key);
  if (!cache) {
    cache = { workspaceRoot, workspaceId, runs: [], corrupted: false, loaded: false, loading: null,
      diskRaw: null, mutationVersion: 0, pending: new Map() };
    workspaces.set(key, cache);
  }
  if (selection === 'active') cache.workspaceId = workspaceId;
  if (switched) { version += 1; emit(); }
  if (cache.loading) return cache.loading;
  if (cache.loaded) return;
  const target = cache;
  const currentGeneration = generation;
  version += 1;
  emit();
  const reader = io;
  if (!reader) { cache.loaded = true; return; }
  const operation = (async () => {
    try {
      const path = teamRunsFilePath(workspaceRoot);
      await writes.get(path);
      const text = reader.storage ? await reader.storage.load(workspaceRoot) : await reader.readFile(path);
      if (currentGeneration !== generation) return;
      if (text === null) return;
      target.diskRaw = text;
      const parsed = parseTeamRunsFile(text);
      if (!parsed) {
        target.corrupted = true;
        return;
      }
      // Events may arrive while disk is being read. Local mutations win.
      const local = target.runs;
      const localIds = new Set(local.map(run => run.id));
      target.runs = [...parsed.runs.filter(run => !localIds.has(run.id)), ...local];
    } catch {
      // Fresh workspaces have no history file; keep any local event updates.
    } finally {
      if (currentGeneration === generation) {
        target.loaded = true;
        target.loading = null;
        version += 1;
        emit();
      }
    }
  })();
  cache.loading = operation;
  await operation;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeTeamRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot token for useSyncExternalStore (bumped on every mutation). */
export function teamRunsVersion(): number {
  return version;
}

export function teamRunsSnapshot(workspace?: string): readonly PersistableTeamRun[] {
  return cacheFor(workspace)?.runs ?? [];
}

/** Roots and stable UI ids name the same cache partition. */
export function teamWorkspaceIdentity(workspace: string): string | undefined {
  return cacheFor(workspace)?.workspaceId;
}

export function isTeamRunsFileCorrupted(workspace?: string): boolean {
  return cacheFor(workspace)?.corrupted ?? false;
}

/**
 * Upsert one run (latest projection wins) and rewrite the file from the
 * FULL cache — never `[currentRun]`. Write failures are logged by the
 * caller boundary; the in-memory cache stays authoritative.
 */
export async function upsertTeamRun(run: PersistableTeamRun, workspace?: string,
  options?: { readonly onlyIfUnchanged?: PersistableTeamRun }): Promise<void> {
  const state = cacheFor(workspace);
  if (!state) return;
  const currentGeneration = generation;
  const clean = toPersistableTeamRun(run);
  const previous = state.runs.find(value => value.id === clean.id);
  if (previous && (clean.updatedAt < previous.updatedAt || (previous.endedAt !== undefined && clean.endedAt === undefined))) return;
  // Rehydrating the same facts must not reorder tied terminal histories or
  // invalidate an in-flight inspection. Still retry persistence below: the
  // previous identical snapshot may have failed to reach disk.
  if (!previous || JSON.stringify(toPersistableTeamRun(previous)) !== JSON.stringify(clean)) {
    state.runs = [...state.runs.filter((r) => r.id !== clean.id), clean];
    version += 1;
    emit();
  }
  if (io?.storage) state.pending.set(clean.id, { version: ++state.mutationVersion, run: clean,
    ...(options?.onlyIfUnchanged ? { onlyIfUnchanged: toPersistableTeamRun(options.onlyIfUnchanged) } : {}) });
  // Initial reads may contain other conversations. Merge them before a full
  // file rewrite, including when this update arrived during that read.
  await state.loading;
  if (currentGeneration !== generation) return;
  if (!io) return;
  if (state.corrupted) {
    // Keep the damaged source available for recovery; memory remains live.
    // eslint-disable-next-line no-console
    console.warn('[team-access] history is corrupt; preserving the original file.');
    return;
  }
  const writer = io;
  const path = teamRunsFilePath(state.workspaceRoot);
  // Native CAS batches dirty runs when its queued operation starts; do not
  // allocate and retain a stale full-file JSON for every streamed update.
  const body = writer.storage ? null : serializeTeamRunsFile(state.workspaceId, state.runs);
  const operation = (writes.get(path) ?? Promise.resolve()).then(async () => {
    try {
      if (currentGeneration !== generation) return;
      if (writer.storage) {
        const mutations = [...state.pending.values()];
        if (mutations.length === 0) return;
        const saved = await commitTeamRuns(writer.storage, state.workspaceRoot, state.workspaceId, state.diskRaw,
          mutations, () => currentGeneration === generation);
        if (!saved || currentGeneration !== generation) return;
        state.diskRaw = saved.raw;
        for (const mutation of mutations) if (state.pending.get(mutation.run.id)?.version === mutation.version) state.pending.delete(mutation.run.id);
        const previousById = new Map(state.runs.map(value => [value.id, value]));
        const merged = new Map(saved.runs.map(value => [value.id,
          sameTeamRun(previousById.get(value.id), value) ? previousById.get(value.id)! : value]));
        for (const mutation of state.pending.values()) merged.set(mutation.run.id, mutation.run);
        const runs = [...merged.values()];
        if (JSON.stringify(runs) !== JSON.stringify(state.runs)) { state.runs = runs; version += 1; emit(); }
        return;
      }
      if (body === null) throw new Error('Legacy team history snapshot missing.');
      await writer.writeFile(path, body);
    } catch (err) {
      // Memory stays authoritative and later saves may retry the full snapshot.
      // eslint-disable-next-line no-console
      console.warn('[team-access] team-runs persist failed:', err);
    }
  });
  writes.set(path, operation);
  await operation;
  if (writes.get(path) === operation) writes.delete(path);
}

/**
 * personConversationId → `active` when any of its runs is non-terminal,
 * else `past`. Derived ONLY from team-runs.json — the conversation
 * record and its `kind` stay untouched (Foundation spec §9.3).
 */
export function teamMarksFromRuns(
  runs: readonly PersistableTeamRun[],
): ReadonlyMap<string, TeamHistoryMark> {
  const marks = new Map<string, TeamHistoryMark>();
  for (const run of runs) {
    const current = marks.get(run.personConversationId);
    if (isTeamRunOpen(run)) {
      marks.set(run.personConversationId, 'active');
    } else if (!current) {
      marks.set(run.personConversationId, 'past');
    }
  }
  return marks;
}

/**
 * The run a conversation's Team surface shows: its non-terminal run
 * first, else the most recently updated terminal one, else null.
 */
export function selectRunForConversation(
  runs: readonly PersistableTeamRun[],
  personConversationId: string,
): PersistableTeamRun | null {
  let active: PersistableTeamRun | null = null;
  let terminal: PersistableTeamRun | null = null;
  for (const run of runs) {
    if (run.personConversationId !== personConversationId) continue;
    if (isTeamRunOpen(run)) {
      if (!active || run.updatedAt > active.updatedAt) active = run;
    } else if (!terminal || run.updatedAt > terminal.updatedAt) terminal = run;
  }
  return active ?? terminal;
}
