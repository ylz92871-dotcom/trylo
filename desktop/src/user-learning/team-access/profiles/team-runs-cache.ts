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
  type PersistedTeamRunStatus,
} from '../persist';

export type TeamHistoryMark = 'active' | 'past';

export interface TeamRunsCacheIo {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, body: string) => Promise<void>;
}

interface CacheState {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly runs: readonly PersistableTeamRun[];
}

let state: CacheState | null = null;
let io: TeamRunsCacheIo | null = null;
let loadSeq = 0;
let version = 0;
const listeners = new Set<() => void>();
/** True when the last load hit unreadable JSON — idle shows a hint, the
 *  bad file is NEVER deleted (Foundation spec §9.3 / §10.9). */
let corrupted = false;

export function configureTeamRunsCache(nextIo: TeamRunsCacheIo | null): void {
  io = nextIo;
  state = null;
  corrupted = false;
  loadSeq += 1;
}

/** Persistable projection of a UI run: strips UI-only fields
 *  (`selectedSeatId`) so they never reach disk (Pitfall 17). */
export function toPersistableTeamRun(
  run: PersistableTeamRun & { readonly selectedSeatId?: unknown },
): PersistableTeamRun {
  const clone: Record<string, unknown> = { ...run };
  delete clone.selectedSeatId;
  return clone as unknown as PersistableTeamRun;
}

function isTerminal(status: PersistedTeamRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Load the full file for a workspace switch. Read failure or malformed
 * JSON ⇒ empty cache with `corrupted` flag; the file is not deleted.
 */
export async function loadTeamRunsForWorkspace(
  workspaceRoot: string,
  workspaceId: string,
): Promise<void> {
  const seq = ++loadSeq;
  state = { workspaceRoot, workspaceId, runs: [] };
  corrupted = false;
  if (!io) return;
  try {
    const text = await io.readFile(teamRunsFilePath(workspaceRoot));
    if (seq !== loadSeq) return;
    const parsed = parseTeamRunsFile(text);
    if (!parsed) {
      corrupted = true;
      return;
    }
    state = { workspaceRoot, workspaceId: parsed.workspaceId || workspaceId, runs: parsed.runs };
    version += 1;
    emit();
  } catch {
    // No file yet (fresh workspace) or unreadable — treat as empty.
    if (seq !== loadSeq) return;
  }
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

export function teamRunsSnapshot(): readonly PersistableTeamRun[] {
  return state?.runs ?? [];
}

export function isTeamRunsFileCorrupted(): boolean {
  return corrupted;
}

/**
 * Upsert one run (latest projection wins) and rewrite the file from the
 * FULL cache — never `[currentRun]`. Write failures are logged by the
 * caller boundary; the in-memory cache stays authoritative.
 */
export async function upsertTeamRun(run: PersistableTeamRun): Promise<void> {
  if (!state) return;
  const clean = toPersistableTeamRun(run);
  const runs = [...state.runs.filter((r) => r.id !== clean.id), clean];
  state = { ...state, runs };
  version += 1;
  emit();
  if (!io) return;
  try {
    await io.writeFile(
      teamRunsFilePath(state.workspaceRoot),
      serializeTeamRunsFile(state.workspaceId, runs),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[team-access] team-runs persist failed:', err);
  }
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
    if (!isTerminal(run.status)) {
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
  let terminal: PersistableTeamRun | null = null;
  for (const run of runs) {
    if (run.personConversationId !== personConversationId) continue;
    if (!isTerminal(run.status)) return run;
    if (!terminal || run.updatedAt > terminal.updatedAt) terminal = run;
  }
  return terminal;
}
