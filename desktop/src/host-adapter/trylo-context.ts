// Trylo Desktop — Production TryloHandlerContext. See
// ARCHITECTURE.md §3 Phase 2 task #1+#2 and the Phase 2 plan §5.
//
// The 6 simple message types in `trylo-message-types.ts` are pure
// dispatch; the side-effecting operations live behind a context
// object. This module wires the context to a thin in-memory session
// store (Phase 2 stub). Phase 3 will swap the in-memory store for
// Project State and route `testConnection` through a real CC CLI call.

import type { TryloHandlerContext } from './trylo-message-types';
import type { TryloMode, TryloSession } from './trylo-api';
import type { FilePath } from './types';

// ── In-memory session store (Phase 2 stub) ────────────────────────────────
//
// The legacy code expects to call `createSession`, `switchSession`,
// `getSessions`, `deleteSession`. For Phase 2 we keep these in memory
// only; persistence comes in Phase 3 with Project State. The store
// is a single `Map` with one "active" pointer.

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

class SessionStore {
  private readonly sessions = new Map<string, TryloSession>();
  private activeId: string | null = null;
  private permissionMode: PermissionMode = 'default';
  private nextId = 1;

  list(): readonly TryloSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  create(input: { mode: TryloMode }): TryloSession {
    const now = Date.now();
    const session: TryloSession = {
      id: `s-${this.nextId++}-${now.toString(36)}`,
      title: `Session ${this.nextId - 1}`,
      mode: input.mode,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
    };
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    return session;
  }

  setActive(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.activeId = id;
    return true;
  }

  delete(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    if (this.activeId === id) {
      this.activeId =
        this.sessions.size > 0
          ? (this.sessions.keys().next().value as string)
          : null;
    }
    return true;
  }

  getActive(): TryloSession | null {
    if (this.activeId === null) return null;
    return this.sessions.get(this.activeId) ?? null;
  }

  setMode(mode: TryloMode): TryloMode {
    const active = this.getActive();
    if (active) {
      this.sessions.set(active.id, { ...active, mode, updatedAt: Date.now() });
    }
    return mode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }
}

// ── Module-level singleton ────────────────────────────────────────────────
//
// The session store is shared across all `TryloFrame` instances.
// In Phase 2 we only mount one iframe, but multi-window (Phase 4)
// will need to scope this per window.

let _store: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (_store === null) {
    _store = new SessionStore();
  }
  return _store;
}

/** For tests: reset the singleton so each test starts clean. */
export function resetSessionStore(): void {
  _store = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

// ── Persistence (per workspace) ─────────────────────────────────
//
// v1.7: sessions are persisted to localStorage, keyed by
// workspace path. When the workspace changes, the store
// re-loads the snapshot for that path. This is intentionally
// a Map<workspacePath, TryloSession[]> in JSON — Phase 3
// replaces this with a real SQLite store; the API doesn't
// change.

const STORAGE_KEY = 'trylo:workspace-sessions:v1';

interface PersistedState {
  readonly workspaces: Record<string, readonly TryloSession[]>;
  readonly active: Record<string, string>;
}

function loadPersisted(): PersistedState {
  if (typeof window === 'undefined') {
    return { workspaces: {}, active: {} };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { workspaces: {}, active: {} };
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      workspaces: parsed.workspaces ?? {},
      active: parsed.active ?? {},
    };
  } catch {
    return { workspaces: {}, active: {} };
  }
}

function savePersisted(state: PersistedState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / private mode
  }
}

let _persisted: PersistedState = loadPersisted();

export function snapshotForWorkspace(workspaceRoot: string): {
  sessions: readonly TryloSession[];
  activeId: string | null;
} {
  const sessions = _persisted.workspaces[workspaceRoot] ?? [];
  const activeId = _persisted.active[workspaceRoot] ?? null;
  return { sessions, activeId };
}

export function persistForWorkspace(
  workspaceRoot: string,
  sessions: readonly TryloSession[],
  activeId: string | null,
): void {
  _persisted = {
    workspaces: { ..._persisted.workspaces, [workspaceRoot]: sessions },
    active: { ..._persisted.active, [workspaceRoot]: activeId ?? '' },
  };
  savePersisted(_persisted);
}

// ── Production context factory ────────────────────────────────────────────

export interface CreateContextOptions {
  workspaceRoot: FilePath;
}

/**
 * Build the production `TryloHandlerContext`. In Phase 2 the
 * `testConnection` and `clearApiKey` methods are no-ops with a
 * "Phase 2 stub" message — the real CC CLI bridge is Phase 3
 * (sub-task 3.4). Phase 2 only needs the iframe to mount and
 * the 6 simple message types to round-trip.
 */
export function createTryloContext(opts: CreateContextOptions): TryloHandlerContext {
  const store = getSessionStore();
  return {
    workspaceRoot: opts.workspaceRoot,
    listSessions: () => store.list(),
    createSession: (input) => store.create(input),
    setActiveSession: (id) => store.setActive(id),
    deleteSession: (id) => store.delete(id),
    getActiveSession: () => store.getActive(),
    setMode: (mode) => store.setMode(mode),
    setPermissionMode: (mode) => store.setPermissionMode(mode),
    async testConnection(): Promise<{ ok: boolean; message: string }> {
      // Phase 2 stub: real CC CLI bridge is Phase 3 task 3.4.
      return {
        ok: true,
        message:
          'Trylo Core not yet wired (Phase 2 stub). See spike-results/phase-2-plan.md §3 task 2.4.',
      };
    },
    async clearApiKey(): Promise<void> {
      // Phase 2 stub: API keys are not yet in AppSettings; the real
      // wipe is a Phase 3 task that introduces `apiKey`/`visionApiKey`
      // to AppSettings and a Tauri command to delete the secret from
      // the OS keychain.
    },
    async clearVisionApiKey(): Promise<void> {
      // Phase 2 stub. See clearApiKey above.
    },
  };
}
