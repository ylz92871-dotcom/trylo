// Trylo Desktop — production Code diagnostics ring buffer (C-Edge P2-5).
//
// A bounded, append-only ring of structured events that captures
// every transition the Code runtime cares about. The buffer:
//   - is module-level (one per app instance, mounted in App.tsx)
//   - never persists to disk; it lives in memory for the session
//   - never carries the run id verbatim — the runId is hashed so an
//     exported diagnostic cannot be tied back to a specific user
//     conversation without the private seed
//   - never carries prompt text, Authorization headers, API keys,
//     email, or private absolute paths — see redact.ts
//   - dedupes duplicate events inside a short window so a noisy
//     retry loop cannot drown the buffer
//
// The controller (code-run-controller) is the single writer. Reads
// happen via `snapshot()` (frozen) or `exportJson()` (string for
// clipboard / log file).

import { anonId } from './redact';

/** Maximum number of events the buffer ever holds. Sized to fit a
 *  10-event-per-second production burst for ~25s without losing
 *  context, with headroom for slower diagnostics. */
export const DIAG_BUFFER_LIMIT = 256;

/** 100ms de-dup window: two events of the same type, same runIdHash,
 *  same reasonCode inside this window collapse to the first. */
const DEDUPE_WINDOW_MS = 100;

export type DiagEventType =
  | 'prewarm.requested'
  | 'prewarm.spawned'
  | 'prewarm.adopted'
  | 'prewarm.late_discarded'
  | 'prompt.write.accepted'
  | 'prompt.write.rejected'
  | 'cold.fallback'
  | 'cold.spawn'
  | 'first.raw_event'
  | 'first.semantic_event'
  | 'watchdog.timeout'
  | 'process.exit'
  | 'terminal'
  // PR-2 (tool-extension spec §3/§4.4): tools/list drift observed at CLI
  // init vs the Profile's expectedTools. reasonCode carries package id +
  // missing/extra tool names.
  | 'tool.protocol_drift';

/** A single ring entry. Frozen so consumers can't accidentally mutate
 *  the buffer mid-export. */
export interface DiagEvent {
  /** Wall-clock millis (epoch). */
  readonly t: number;
  readonly type: DiagEventType;
  /** 16 hex chars of FNV-1a(runId) — anonymous, stable. */
  readonly runIdHash: string;
  /** 12 hex chars of FNV-1a(projectKey). */
  readonly projectAnonId: string;
  /** 12 hex chars of FNV-1a(conversationId). */
  readonly conversationAnonId: string;
  /** Latency for this transition, in ms. Omitted when not measured. */
  readonly latencyMs?: number;
  /** Short, stable machine code (e.g. 'EPIPE', 'EAGAIN', 'closed_stdin'). */
  readonly reasonCode?: string;
  /** Process exit code — present on `process.exit` only. */
  readonly exitCode?: number;
  /** Process signal — present on `process.exit` only when killed. */
  readonly signal?: number;
}

/** Input the writer feeds; the buffer normalises and hashes. */
export interface DiagEventInput {
  readonly type: DiagEventType;
  readonly runId: string;
  readonly projectKey: string;
  readonly conversationId: string;
  readonly latencyMs?: number;
  readonly reasonCode?: string;
  readonly exitCode?: number;
  readonly signal?: number;
  /** Wall-clock millis override (test seam). */
  readonly at?: number;
}

export interface CodeDiagnosticsBufferOptions {
  readonly now?: () => number;
  /** Override limit (test seam). */
  readonly limit?: number;
}

export interface CodeDiagnosticsSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly dropped: number;
  readonly events: readonly DiagEvent[];
}

export class CodeDiagnosticsBuffer {
  private readonly ring: DiagEvent[] = [];
  private readonly limit: number;
  private readonly now: () => number;
  /** Index of the last deduped event per (type, runIdHash, reasonCode). */
  private readonly lastSeen = new Map<string, number>();
  /** Total events ever dropped due to the limit. */
  private dropped = 0;
  private listeners = new Set<(snap: CodeDiagnosticsSnapshot) => void>();

  constructor(options: CodeDiagnosticsBufferOptions = {}) {
    this.limit = options.limit ?? DIAG_BUFFER_LIMIT;
    this.now = options.now ?? (() => Date.now());
  }

  /** Append an event. Drops duplicates inside the dedup window.
   *  Drops the oldest entry when the ring is full. */
  push(input: DiagEventInput): void {
    const runIdHash = anonId(input.runId, 16);
    const projectAnonId = anonId(input.projectKey, 12);
    const conversationAnonId = anonId(input.conversationId, 12);
    const reason = input.reasonCode ?? '';
    const key = `${input.type}|${runIdHash}|${reason}`;
    const at = input.at ?? this.now();
    const prev = this.lastSeen.get(key);
    if (prev !== undefined && at - prev < DEDUPE_WINDOW_MS) {
      return; // de-dupe: same shape inside the window
    }
    this.lastSeen.set(key, at);
    // Evict the OLDEST `lastSeen` entry once it falls outside the
    // dedup window so the map cannot grow without bound.
    if (this.lastSeen.size > this.limit * 4) {
      const cutoff = at - DEDUPE_WINDOW_MS * 4;
      for (const [k, when] of this.lastSeen) {
        if (when < cutoff) this.lastSeen.delete(k);
      }
    }
    const event: DiagEvent = {
      t: at,
      type: input.type,
      runIdHash,
      projectAnonId,
      conversationAnonId,
      ...(input.latencyMs !== undefined ? { latencyMs: Math.max(0, Math.floor(input.latencyMs)) } : {}),
      ...(reason ? { reasonCode: reason } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
    if (this.ring.length >= this.limit) {
      this.ring.shift();
      this.dropped += 1;
    }
    this.ring.push(Object.freeze(event));
    this.notify();
  }

  /** Read-only view of the current buffer. Frozen. */
  snapshot(): CodeDiagnosticsSnapshot {
    return Object.freeze({
      schemaVersion: 1 as const,
      generatedAt: this.now(),
      dropped: this.dropped,
      events: Object.freeze([...this.ring]),
    });
  }

  /** Serialise the snapshot to JSON (clipboard-friendly). */
  exportJson(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  /** Drop every event. */
  clear(): void {
    this.ring.length = 0;
    this.lastSeen.clear();
    this.dropped = 0;
    this.notify();
  }

  /** Subscribe to push notifications. Returns an unsubscribe. */
  subscribe(listener: (snap: CodeDiagnosticsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const l of [...this.listeners]) {
      try {
        l(snap);
      } catch {
        // A listener must never poison the buffer.
      }
    }
  }
}
