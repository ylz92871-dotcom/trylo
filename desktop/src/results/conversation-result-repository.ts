// Trylo Desktop — P2-1 ConversationResultRepository (spec §5.1 / §13.3).
//
// In-memory store keyed by (projectKey, conversationId) with an immutable
// latest snapshot per conversation. It never parses Git, never parses Work
// frames and never renders React. Persistence is delegated to a port so the
// repository stays framework-free: App registers `onVisual` / `onSave`
// callbacks that collapse `results` into `ConversationRecord` and schedule
// the existing per-workspace write-behind chain.

import {
  normalizeConversationResults,
  type BOUNDS,
} from './conversation-result-normalizer';
import type { StoredConversationResults } from './conversation-result-types';

export interface ResultSnapshot {
  readonly projectKey: string;
  readonly conversationId: string;
  /** Monotonic per-conversation version; consumed as a subscription key. */
  readonly version: number;
  readonly results: StoredConversationResults;
}

export type ResultListener = (snapshot: ResultSnapshot) => void;

export type ResultUpdater = (
  previous: StoredConversationResults,
) => StoredConversationResults;

interface Entry {
  conversationId: string;
  results: StoredConversationResults;
  version: number;
}

export class ConversationResultRepository {
  private readonly byKey = new Map<string, Entry>();
  private readonly listeners = new Set<ResultListener>();

  private key(projectKey: string, conversationId: string): string {
    return `${projectKey}::${conversationId}`;
  }

  /** Load a stored (normalised) payload for a conversation. When the
   *  payload has nothing meaningful (old / corrupt / absent), no entry is
   *  created and any existing in-memory snapshot is preserved. */
  hydrate(projectKey: string, conversationId: string, stored: unknown): void {
    const results = normalizeConversationResults(stored);
    const key = this.key(projectKey, conversationId);
    const prior = this.byKey.get(key);
    if (!results) return; // nothing to hydrate; keep prior if any
    const entry: Entry = {
      conversationId,
      results,
      // Hydration never resets a version backwards. If a fresher in-memory
      // snapshot already exists (same-session), keep its version.
      version: (prior?.version ?? 0) + 1,
    };
    this.byKey.set(key, entry);
    this.notify(projectKey, entry);
  }

  /** Read the current normalised snapshot (immutable). */
  snapshot(projectKey: string, conversationId: string): StoredConversationResults | undefined {
    return this.byKey.get(this.key(projectKey, conversationId))?.results;
  }

  /** Apply an atomic, mode-scoped update and normalise the result. */
  update(
    projectKey: string,
    conversationId: string,
    updater: ResultUpdater,
  ): void {
    const key = this.key(projectKey, conversationId);
    const prior = this.byKey.get(key);
    const base = prior?.results ?? { schemaVersion: 1 };
    const next = normalizeConversationResults(updater(base)) ?? { schemaVersion: 1 };
    const entry: Entry = {
      conversationId,
      results: next,
      version: (prior?.version ?? 0) + 1,
    };
    this.byKey.set(key, entry);
    this.notify(projectKey, entry);
  }

  clearProject(projectKey: string): void {
    const prefix = `${projectKey}::`;
    for (const key of this.byKey.keys()) {
      if (key.startsWith(prefix)) {
        this.byKey.delete(key);
      }
    }
  }

  subscribe(listener: ResultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(projectKey: string, entry: Entry): void {
    const snapshot: ResultSnapshot = {
      projectKey,
      conversationId: entry.conversationId,
      version: entry.version,
      results: entry.results,
    };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A listener must never poison the repository's write path.
      }
    }
  }
}

// Re-export the bounds so the persistence adapter can use the same limits
// without importing the normalizer internals.
export type { BOUNDS };