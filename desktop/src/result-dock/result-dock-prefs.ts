// Trylo Desktop — conversation-scoped ResultDock UI preferences
// (C-Edge P2-4).
//
// UI state that the ResultDock reads is *not* part of the result
// source-of-truth. The persisted `ConversationRecord.results` stays
// immutable; the collapse / expand state lives here, keyed by
// `(surface, projectKey, conversationId)`. Reasons:
//
//   - a user collapse must survive route changes and re-mounts;
//   - Code and Work must have INDEPENDENT collapse state — collapsing
//     Code's dock must not collapse Work's dock in the same
//     conversation;
//   - conversation deletion / project close also clears the prefs so
//     no zombie state lingers after the user has moved on.
//
// The store is in-memory only; it is intentionally NOT persisted to
// disk. UI preference is session-scoped; we never want to surprise the
// user with a remembered collapse on a future session.

export type ResultDockSurface = 'code' | 'work';

export interface ResultDockKey {
  readonly surface: ResultDockSurface;
  readonly projectKey: string;
  readonly conversationId: string;
}

export interface ResultDockPrefs {
  /** true = expanded, false = collapsed. */
  readonly open: boolean;
  readonly lastUpdatedAt: number;
}

export function resultDockKeyToString(key: ResultDockKey): string {
  return `${key.surface}|${key.projectKey}|${key.conversationId}`;
}

export class ResultDockPrefsStore {
  private readonly entries = new Map<string, ResultDockPrefs>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Read the prefs for one key. `undefined` means "no record yet,
   *  caller should use its own default". */
  get(key: ResultDockKey): ResultDockPrefs | undefined {
    return this.entries.get(resultDockKeyToString(key));
  }

  /** Convenience: get the open flag, falling back to a caller-supplied
   *  default when no entry exists. */
  getOpen(key: ResultDockKey, fallback: boolean): boolean {
    return this.entries.get(resultDockKeyToString(key))?.open ?? fallback;
  }

  /** Set the open flag. `now` defaults to `Date.now()` and is
   *  exposed for tests. */
  setOpen(key: ResultDockKey, open: boolean, now: number = Date.now()): void {
    const id = resultDockKeyToString(key);
    const prev = this.entries.get(id);
    if (prev && prev.open === open) return; // no-op
    this.entries.set(id, { open, lastUpdatedAt: now });
    this.notify(id);
  }

  /** Drop a conversation's prefs. Called when a conversation is
   *  deleted (Code/Work). Safe to call when no prefs exist. */
  clearConversation(key: ResultDockKey): void {
    const id = resultDockKeyToString(key);
    if (!this.entries.delete(id)) return;
    this.notify(id);
  }

  /** Drop every prefs entry for a project (workspace close /
   *  switch). All surfaces. */
  clearProject(projectKey: string): void {
    const prefix = `${projectKey}|`; // matches any surface
    const matched: string[] = [];
    for (const k of this.entries.keys()) {
      const parts = k.split('|');
      if (parts.length === 3 && parts[1] === projectKey) matched.push(k);
    }
    for (const k of matched) {
      this.entries.delete(k);
      this.notify(k);
    }
    // also keep the prefix branch in case future shape changes
    if (matched.length === 0 && this.entries.size > 0) {
      for (const k of [...this.entries.keys()]) {
        if (k.startsWith(prefix)) {
          this.entries.delete(k);
          this.notify(k);
        }
      }
    }
  }

  /** Subscribe to changes for one key. Fires on setOpen, clear, etc. */
  subscribeKey(key: ResultDockKey, listener: () => void): () => void {
    const id = resultDockKeyToString(key);
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(id);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(id);
    };
  }

  /** Test seam: number of stored entries. */
  size(): number {
    return this.entries.size;
  }

  private notify(id: string): void {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l();
      } catch {
        // a misbehaving listener must never poison the store
      }
    }
  }
}

// Production singleton — one per app instance, mounted in App.tsx
// once and passed into ResultDock via a useSyncExternalStore hook.
export const resultDockPrefsStore = new ResultDockPrefsStore();
