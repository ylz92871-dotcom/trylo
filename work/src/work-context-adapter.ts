// Trylo Work — WorkContextAdapter.
//
// M4-C2 / M4-C3 (architecture doc §4.4 / §6.4; capability audit
// §5). There is no shared context on the Code side for Work: Work's
// owner is the cowork task / SessionRuntime, which has its own
// conversation history, durable snapshot, follow-up runs and active
// compaction lifecycle. The adapter is the pure consumer that turns
// the events Work actually emits (llm_usage + context_compaction_*)
// into one generic `ContextSnapshot` per durable taskId, so the
// renderer can show "Task context" without reaching into Control
// Plane payloads. It never talks to Code and never issues a
// `/compact`.
//
// Hard rules (audit §5.5 / spec §4.4):
//   - `totals.inputTokens` is cumulative billing and must NEVER be
//     shown as "context used"; only `delta.inputTokens` from the
//     most recent provider report is a valid "used" figure.
//   - unknown model / missing usage renders as `—`, never a guessed
//     200k.
//   - compaction is projected per EVENT type, never faked.
//
// Data-source priority for `used` (spec §6.4):
//   1. provider_usage  — llm_usage.delta.inputTokens (real);
//   2. compaction_event — context_compaction_*.tokensAfter (estimate);
//   3. cowork_estimate — task.get restore of last compaction;
//   4. unknown         — nothing yet → undefined (render `—`).

/** What produced the `usedTokens` figure. */
export type ContextSource =
  | "provider_usage"
  | "cowork_estimate"
  | "compaction_event"
  | "unknown";

export type CompactionState = "idle" | "running" | "completed" | "failed";

/** Auto-compaction projection (spec §4.4 `compaction`). Never
 *  invented; driven only by context_compaction_* events and the
 *  task.get restore. */
export interface ContextCompaction {
  readonly state: CompactionState;
  readonly count: number;
  readonly lastAt?: number;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly error?: string;
}

/** The single, mode-agnostic snapshot Work exposes for the shared
 *  context UI (spec §4.4). Immutable; every update replaces it
 *  wholesale so React can diff by reference. */
export interface ContextSnapshot {
  readonly mode: "work";
  readonly modelId?: string;
  readonly provider?: string;
  readonly usedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly ratio?: number;
  /** Which source supplied `usedTokens`. */
  readonly source: ContextSource;
  /** True when `usedTokens` is an estimate, not a provider report. */
  readonly estimated: boolean;
  readonly observedAt: number;
  readonly compaction: ContextCompaction;
}

/** A normalized context event the runtime feeds the adapter — the
 *  only way the adapter learns about daemon activity. Built by
 *  `extractWorkContextEvent` from a raw `task.event` frame. */
export interface WorkContextEvent {
  readonly taskId: string;
  readonly kind:
    | "llm_usage"
    | "context_compaction_started"
    | "context_compaction_completed"
    | "context_compaction_failed";
  readonly at: number;
  /** llm_usage */
  readonly model?: string;
  readonly provider?: string;
  readonly deltaInputTokens?: number;
  /** context_compaction_* */
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly error?: string;
}

/** Minimal model-name → context-window inference for the Work side.
 *  Mirrors the Code side's contextWindowFor contract. Unknown models
 *  return `undefined` — the caller renders `—` (spec §6.4 and §14
 *  forbid inventing a 200k default). Only models with a KNOWN window
 *  resolve to a number. P2-2: the prior single-entry "matches" table
 *  made every case return the same 200k, silently guessing. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Best-effort denominator for the Work context bar. Known Claude
 *  3.5+/4-family models → DEFAULT_CONTEXT_WINDOW; anything else →
 *  undefined so the indicator renders `—` instead of a guessed
 *  window (and never a misleading "used · 0%"). */
export function workContextWindowFor(
  model: string | null | undefined,
): number | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  const known = [
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-haiku-4",
    "claude-3-7-sonnet",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-3-opus",
    "claude-3-sonnet",
    "claude-3-haiku",
  ];
  if (known.some((m) => lower.includes(m))) return DEFAULT_CONTEXT_WINDOW;
  return undefined;
}

/** A snapshot that is a valid "unknown" (no context data yet).
 *  Exported so the renderer can seed / fall back deterministically. */
export function emptyWorkContextSnapshot(observedAt = Date.now()): ContextSnapshot {
  return {
    mode: "work",
    source: "unknown",
    estimated: false,
    observedAt,
    compaction: { state: "idle", count: 0 },
  };
}

/**
 * Pull a `WorkContextEvent` out of a raw Control Plane frame, or
 * null when the frame is not a `task.event` whose inner `type` is
 * `llm_usage` / `context_compaction_started|completed|failed`.
 *
 * This is the ONLY place the protocol's `task.event` payload for
 * context is read; the adapter and the runtime never inspect frames
 * themselves (architecture doc §6.4 "…不能直接从 App 读取"). Field
 * names are read defensively so a renamed / absent field degrades to
 * "no data" (render `—`) instead of throwing.
 */
export function extractWorkContextEvent(
  frame: {
    readonly event?: string;
    readonly payload?: unknown;
  },
  at = Date.now(),
): WorkContextEvent | null {
  if (frame.event !== "task.event") return null;
  if (typeof frame.payload !== "object" || frame.payload === null) return null;
  const inner = frame.payload as Record<string, unknown>;
  const taskId = typeof inner["taskId"] === "string" ? (inner["taskId"] as string) : "";
  const type = typeof inner["type"] === "string" ? (inner["type"] as string) : "";
  if (!taskId) return null;

  // Field names anchor to the vendor payload (P1-1): SessionRuntime
  // emits `{ providerType, modelId, delta:{ inputTokens, ... } }`
  // (see `vendor/.../SessionRuntime.test.ts`). Reading `model` /
  // `provider` silently nulls both, losing the context window and
  // yielding misleading "used · 0%" — the exact defect M4-C P1-1
  // called out.
  if (type === "llm_usage") {
    const model = typeof inner["modelId"] === "string" ? (inner["modelId"] as string) : undefined;
    const provider =
      typeof inner["providerType"] === "string"
        ? (inner["providerType"] as string)
        : undefined;
    const delta =
      typeof inner["delta"] === "object" && inner["delta"] !== null
        ? (inner["delta"] as Record<string, unknown>)
        : undefined;
    const deltaInputTokens =
      delta && typeof delta["inputTokens"] === "number" && Number.isFinite(delta["inputTokens"])
        ? (delta["inputTokens"] as number)
        : undefined;
    return {
      taskId,
      kind: "llm_usage",
      at,
      model,
      provider,
      deltaInputTokens,
    };
  }

  if (
    type === "context_compaction_started" ||
    type === "context_compaction_completed" ||
    type === "context_compaction_failed"
  ) {
    const tokensBefore = num(inner["tokensBefore"]);
    const tokensAfter = num(inner["tokensAfter"]);
    // Vendored shape (P1-1): SessionRuntime emits
    // `context_compaction_failed { ..., reason }` (SessionRuntime.ts
    // L1675-1679). Reading `error` was silently nulling the reason.
    const error = typeof inner["reason"] === "string" ? (inner["reason"] as string) : undefined;
    return {
      taskId,
      kind: type as
        | "context_compaction_started"
        | "context_compaction_completed"
        | "context_compaction_failed",
      at,
      tokensBefore,
      tokensAfter,
      error,
    };
  }
  return null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? (value as number) : undefined;
}

/**
 * Pure builder of ContextSnapshots from one WorkContextEvent at a
 * time. Owns one immutable snapshots map keyed by durable taskId, so
 * a task's follow-up runs share its context while `used` reflects the
 * CURRENT report (a new run's first llm_usage replaces the previous
 * run's used figure; compaction count is cumulative across runs).
 *
 * The runtime owns exactly one adapter and feeds it every relevant
 * frame; React only reads `snapshot(taskId)`.
 */
export class WorkContextAdapter {
  /** Latest snapshot per durable taskId, or undefined when the task
   *  has produced no context data yet. */
  private readonly byTask = new Map<string, ContextSnapshot>();
  private readonly listeners = new Set<() => void>();

  /** Consume one normalized context event. Replaces the task's
   *  snapshot and notifies listeners. Never throws. */
  consume(event: WorkContextEvent): void {
    const prior = this.byTask.get(event.taskId);
    const next =
      event.kind === "llm_usage"
        ? this.applyLlmUsage(prior, event)
        : this.applyCompaction(prior, event);
    this.byTask.set(event.taskId, next);
    this.notify();
  }

  /** Restore compaction state from a task.get payload after refresh
   *  (priority 3). Only applies when the payload carries real numbers
   *  — a task with no compaction history leaves the snapshot
   *  untouched so the UI keeps showing `—`. */
  restoreFromTaskGet(
    taskId: string,
    payload: {
      readonly compactionCount?: unknown;
      readonly lastCompactionAt?: unknown;
      // Vendored names (P1-1): the task.get task object carries
      // `lastCompactionTokensBefore/After` (see
      // vendor/.../shared/types.ts L2496-2499). The prior
      // `compactedTokens*` reads always returned undefined.
      readonly lastCompactionTokensBefore?: unknown;
      readonly lastCompactionTokensAfter?: unknown;
    },
    observedAt = Date.now(),
  ): void {
    const count = asNonNegInt(payload.compactionCount);
    const lastAt = asPosNumber(payload.lastCompactionAt);
    const tokensBefore = asNonNegInt(payload.lastCompactionTokensBefore);
    const tokensAfter = asNonNegInt(payload.lastCompactionTokensAfter);
    const prior = this.byTask.get(taskId);
    if (count === undefined && lastAt === undefined && tokensBefore === undefined && tokensAfter === undefined) {
      return; // no compaction metadata — do not invent data
    }
    const compaction: ContextCompaction = {
      state: prior?.compaction.state === "running" ? "running" : count ? "completed" : "idle",
      count: count ?? prior?.compaction.count ?? 0,
      lastAt: lastAt ?? prior?.compaction.lastAt,
      tokensBefore,
      tokensAfter,
    };
    const used = prior?.usedTokens;
    const source: ContextSource = prior?.source ?? "unknown";
    this.byTask.set(taskId, this.buildSnapshot(prior, {
      usedTokens: used,
      source,
      estimated: prior?.estimated ?? false,
      observedAt,
      compaction,
    }));
    this.notify();
  }

  /** Current snapshot for a task, or undefined when there is none. */
  snapshot(taskId: string): ContextSnapshot | undefined {
    return this.byTask.get(taskId);
  }

  /** Snapshot for a task, falling back to an empty "unknown"
   *  snapshot so callers never have to thread an undefined. */
  snapshotOrEmpty(taskId: string): ContextSnapshot {
    return this.snapshot(taskId) ?? emptyWorkContextSnapshot();
  }

  /** Subscribe to every snapshot change. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private applyLlmUsage(
    prior: ContextSnapshot | undefined,
    ev: WorkContextEvent,
  ): ContextSnapshot {
    const hasDelta = ev.deltaInputTokens !== undefined;
    const used = hasDelta ? Number(ev.deltaInputTokens) : prior?.usedTokens;
    const modelId = ev.model ?? prior?.modelId;
    const contextWindowTokens =
      modelId !== undefined ? workContextWindowFor(modelId) : prior?.contextWindowTokens;
    return this.buildSnapshot(prior, {
      modelId,
      provider: ev.provider ?? prior?.provider,
      usedTokens: used,
      contextWindowTokens,
      source: "provider_usage",
      estimated: false,
      observedAt: ev.at,
      compaction: prior?.compaction ?? { state: "idle", count: 0 },
    });
  }

  private applyCompaction(
    prior: ContextSnapshot | undefined,
    ev: WorkContextEvent,
  ): ContextSnapshot {
    const base = prior?.compaction ?? { state: "idle" as CompactionState, count: 0 };
    let compaction: ContextCompaction;
    if (ev.kind === "context_compaction_started") {
      compaction = {
        state: "running",
        count: base.count,
        lastAt: base.lastAt, // previous completion, if any
        tokensBefore: asNonNegInt(ev.tokensBefore) ?? base.tokensBefore,
        tokensAfter: asNonNegInt(ev.tokensAfter) ?? base.tokensAfter,
      };
    } else if (ev.kind === "context_compaction_completed") {
      compaction = {
        state: "completed",
        count: base.count + 1,
        lastAt: ev.at,
        tokensBefore: asNonNegInt(ev.tokensBefore) ?? base.tokensBefore,
        tokensAfter: asNonNegInt(ev.tokensAfter) ?? base.tokensAfter,
      };
    } else {
      compaction = {
        state: "failed",
        count: base.count,
        lastAt: ev.at,
        tokensBefore: asNonNegInt(ev.tokensBefore) ?? base.tokensBefore,
        tokensAfter: asNonNegInt(ev.tokensAfter) ?? base.tokensAfter,
        error: ev.error,
      };
    }

    // used falls back to the co-work estimate AFTER a compaction when
    // the provider hasn't reported yet (priority 2). Never overrides a
    // provider report (priority 1 wins).
    let used = prior?.usedTokens;
    let source: ContextSource = prior?.source ?? "unknown";
    let estimated = prior?.estimated ?? false;
    if (prior?.source !== "provider_usage" && compaction.tokensAfter !== undefined) {
      used = compaction.tokensAfter;
      source = "compaction_event";
      estimated = true;
    }
    return this.buildSnapshot(prior, {
      usedTokens: used,
      source,
      estimated,
      observedAt: ev.at,
      compaction,
    });
  }

  private buildSnapshot(
    prior: ContextSnapshot | undefined,
    patch: Pick<
      ContextSnapshot,
      | "usedTokens"
      | "source"
      | "estimated"
      | "observedAt"
      | "compaction"
    > & {
      readonly modelId?: string;
      readonly provider?: string;
      readonly contextWindowTokens?: number;
    },
  ): ContextSnapshot {
    const contextWindowTokens =
      patch.contextWindowTokens ?? prior?.contextWindowTokens;
    const used = patch.usedTokens;
    const ratio =
      typeof used === "number" &&
      Number.isFinite(used) &&
      typeof contextWindowTokens === "number" &&
      contextWindowTokens > 0
        ? trimmedRatio(used / contextWindowTokens)
        : undefined;
    // Normalize used to undefined when it is negative / not finite —
    // a malformed provider report must render as `—`, not 0.
    const normUsed = asNonNegInt(used);
    return {
      mode: "work",
      modelId: patch.modelId ?? prior?.modelId,
      provider: patch.provider ?? prior?.provider,
      usedTokens: normUsed,
      contextWindowTokens,
      ratio,
      source: normUsed !== undefined ? patch.source : "unknown",
      estimated: patch.estimated,
      observedAt: patch.observedAt,
      compaction: patch.compaction,
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function asNonNegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.round(value);
}

function asPosNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/** Clamp a ratio to [0, 1] and round to 3 decimal places so UI never
 *  renders >100% from a provider over-report. */
function trimmedRatio(n: number): number {
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}