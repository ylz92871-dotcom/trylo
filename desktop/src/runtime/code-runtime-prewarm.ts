// Trylo Desktop — CodeRuntimePrewarm.
//
// M4-C1 (architecture spec §7.1). Moves the CLI cold-start
// (Node loading the ~50.8 MiB single-file bundle, ~0.71–0.82s
// locally) OUT of the user's first-send critical path by spawning
// an idle Code CLI ahead of time — with NO prompt, so it never
// triggers a model request or writes conversation history.
//
// This class is the pure POLICY (state machine + idle TTL + LRU
// reclaim). It owns NO process and no clock beyond an injectable
// `now()`. The supervisor drives it:
//   - `ensure()` spawns the idle runtime (wiring the actual spawn
//     primitive) and starts warming;
//   - `markReady()` is called when the CLI's `session_start` event
//     arrives — NOT when `process_spawn` returns, because Rust
//     spawn return only proves the OS child was created (§7.1);
//   - `claim()` decides whether a ready warm runtime can be adopted
//     by the next turn ('warm'), is still warming ('warming'), or
//     needs a cold spawn ('cold');
//   - `retain()` cancels the idle TTL after a warm turn so the same
//     runtime stays available;
//   - `reclaim()` evicts IDLE runtimes past TTL (LRU), never busy.
//
// State per §7.1:  not_started -> warming -> ready -> idle
//                             |           \-> failed
//                             \-> failed     idle -> exited

export type PrewarmState =
  | 'not_started'
  | 'warming'
  | 'ready' // runtime init done, CLI idle and reusable
  | 'idle' // was used, still reusable until TTL
  | 'failed'
  | 'exited';

export interface PrewarmEntry {
  readonly projectKey: string;
  readonly conversationId: string;
  state: PrewarmState;
  /** ms timestamp when `markReady` fired (session_start). */
  readonly warmedAt: number;
  /** ms timestamp of the last retain/use. Drives the idle TTL. */
  lastActiveAt: number;
  /** Optional policy accounting: how many turns reused this. */
  reuseCount: number;
}

export type ClaimResult =
  | { kind: 'warm'; entry: PrewarmEntry }
  | { kind: 'warming'; entry: PrewarmEntry }
  | { kind: 'cold' };

export interface PrewarmPolicyOptions {
  /** Idle retention time after which an idle runtime is reclaimed
   *  (spec §5.5: 10–20 min). */
  readonly idleTtlMs: number;
  /** Hard cap on concurrently live warm runtimes (LRU eviction
   *  target). Default unlimited unless provided. */
  readonly maxLive?: number;
  readonly now?: () => number;
}

export function prewarmKey(projectKey: string, conversationId: string): string {
  return `${projectKey}::${conversationId}`;
}

export class CodeRuntimePrewarm {
  private readonly entries = new Map<string, PrewarmEntry>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private readonly maxLive: number | undefined;

  constructor(opts: PrewarmPolicyOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.idleTtlMs = opts.idleTtlMs;
    this.maxLive = opts.maxLive;
  }

  getEntry(projectKey: string, conversationId: string): PrewarmEntry | undefined {
    return this.entries.get(prewarmKey(projectKey, conversationId));
  }

  liveEntries(): readonly PrewarmEntry[] {
    return Array.from(this.entries.values());
  }

  /** Start warming (or no-op if already warming/ready/idle).
   *  Returns the entry. `failed`/`exited` entries are allowed to
   *  restart warm from scratch. */
  ensure(projectKey: string, conversationId: string): PrewarmEntry {
    const key = prewarmKey(projectKey, conversationId);
    const existing = this.entries.get(key);
    if (existing && existing.state !== 'failed' && existing.state !== 'exited') {
      return existing;
    }
    const entry: PrewarmEntry = {
      projectKey,
      conversationId,
      state: 'warming',
      warmedAt: 0,
      lastActiveAt: this.now(),
      reuseCount: 0,
    };
    this.entries.set(key, entry);
    this.enforceMaxLive();
    return entry;
  }

  /** Called when the CLI emits `session_start` — the structured
   *  ready gate. warming -> ready. */
  markReady(projectKey: string, conversationId: string): void {
    const e = this.entries.get(prewarmKey(projectKey, conversationId));
    if (!e) return;
    if (e.state !== 'warming') return;
    const now = this.now();
    (e as { warmedAt: number; lastActiveAt: number }).warmedAt = now;
    e.lastActiveAt = now;
    e.state = 'ready';
  }

  markFailed(projectKey: string, conversationId: string,): void {
    const e = this.entries.get(prewarmKey(projectKey, conversationId));
    if (!e) return;
    e.state = 'failed';
  }

  /** Call when a turn completes on a warm runtime so its idle TTL
   *  restarts to `now`. Keeps state as `idle` unless it was already
   *  a fresh `ready` (never used yet) — both are reusable. */
  retain(projectKey: string, conversationId: string): void {
    const e = this.entries.get(prewarmKey(projectKey, conversationId));
    if (!e) return;
    if (e.state === 'ready' || e.state === 'idle') {
      e.lastActiveAt = this.now();
      e.state = 'idle';
      (e as { reuseCount: number }).reuseCount += 1;
    }
  }

  /** Decide how the next turn gets a runtime. "Warm" hands back a
   *  ready/idle runtime that can be adopted immediately. "Warming"
   *  means a spawn is in flight (the send path shows "Preparing Code
   *  runtime…" and waits). "Cold" means nothing is live — spawn now. */
  claim(projectKey: string, conversationId: string): ClaimResult {
    const e = this.entries.get(prewarmKey(projectKey, conversationId));
    if (!e) return { kind: 'cold' };
    switch (e.state) {
      case 'ready':
      case 'idle':
        return { kind: 'warm', entry: e };
      case 'warming':
        return { kind: 'warming', entry: e };
      default:
        return { kind: 'cold' };
    }
  }

  /** Evict idle runtimes past their TTL. Returns the keys evicted.
   *  LRU by `lastActiveAt`; never touches anything not idle. When
   *  `maxLive` is set, oldest idle runtimes are also dropped to
   *  respect the cap. */
  reclaim(now = this.now()): readonly string[] {
    const evicted: string[] = [];
    for (const [key, e] of this.entries) {
      if (e.state !== 'idle') continue;
      if (now - e.lastActiveAt >= this.idleTtlMs) {
        (e as { state: PrewarmState }).state = 'exited';
        this.entries.delete(key);
        evicted.push(key);
      }
    }
    this.enforceMaxLive(evicted);
    return evicted;
  }

  /** Forget a conversation (run deleted / conversation removed).
   *  Busy (ready/idle) runtimes owned by the controller are the
   *  controller's to stop — the WARM registry only drops its book-
   *  keeping, so it never confuses a deleted conversation. */
  remove(projectKey: string, conversationId: string): void {
    this.entries.delete(prewarmKey(projectKey, conversationId));
  }

  clear(): void {
    this.entries.clear();
  }

  private enforceMaxLive(alreadyEvicted: string[] = []): void {
    if (this.maxLive === undefined) return;
    // Longest-idle first is LRU order; pre-touch live entries are
    // kept (never evict non-idle).
    const idle = Array.from(this.entries.values())
      .filter((e) => e.state === 'idle')
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    const live = this.entries.size;
    let overflow = live - this.maxLive;
    for (const e of idle) {
      if (overflow <= 0) break;
      const key = prewarmKey(e.projectKey, e.conversationId);
      if (alreadyEvicted.includes(key)) continue;
      (e as { state: PrewarmState }).state = 'exited';
      this.entries.delete(key);
      overflow -= 1;
      alreadyEvicted.push(key);
    }
  }
}