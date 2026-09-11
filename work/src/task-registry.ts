// Trylo Work — TaskRegistry.
//
// v1.16.5+ (W-RUN-002, Phase B1 of the M1 lifecycle
// milestone): the single source of truth for active task
// identity. Replaces the previous global
// `workRunTargetRef: { root, sessionId }` singleton, which
// silently misrouted events whenever two tasks ran in the
// same workspace, or when a stale task's events arrived
// after the user started a new one.
//
// Each task is bound to exactly one Trylo conversation by
// `conversationId`. The renderer reads the binding to know
// which message stream an incoming event belongs to, and
// updates the binding's status when the daemon reports a
// terminal state. Persistence lives in the renderer's
// conversation-history file (see `taskId` field on each
// conversation); this registry is the in-memory cache
// and the routing authority.
//
// All operations are pure data — no React, no Tauri, no
// async. The renderer subscribes to changes via
// `subscribe()` if it needs re-render triggers; the
// reconciler and event router are separate consumers.

import {
  intentFromIsChat,
  type WorkTurnIntent,
} from "./work-domain.js";

/** Status of a task as reported by the daemon (or our
 *  best-effort mirror of it). The reconciler (Phase B3)
 *  is the source of truth; this is just the cached value. */
export type TaskStatus =
  | "pending"
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * How a local run was delivered to the daemon (architecture
 * doc §6.1 / §4.3 WorkTurnRun.delivery):
 *   - `create`     the first user turn; sent via `task.create`
 *   - `follow_up`  a continuation turn on the same durable
 *                  task; sent via `task.sendMessage`
 */
export type WorkDelivery = "create" | "follow_up";

/** A task record, bound to a Trylo conversation.
 *
 *  - `taskId`           the daemon-side UUID (durable
 *                        thread id — survives terminal,
 *                        shared by every follow-up run)
 *  - `runId`            Trylo's identity for the CURRENT
 *                        run (one user turn). Unique per
 *                        turn, never derived from taskId —
 *                        a single task can have many runs
 *                        (architecture doc §4.3). Cards,
 *                        projections and diagnostics key
 *                        off this, never off taskId alone.
 *  - `turnId`           the user message that started the
 *                        current run; the renderer supplies
 *                        it at startTask / sendMessage /
 *                        re-bind time. Never guessed from
 *                        "latest user message".
 *  - `delivery`         whether the current run was a
 *                        `create` or a `follow_up` (optional
 *                        so fixture-less records stay valid)
 *  - `workspaceId`      the cowork workspace UUID
 *  - `projectRoot`      Trylo's notion of "which project this is"
 *  - `conversationId`   the Trylo conversation (chat surface)
 *                        the task's events should land in
 *  - `sessionId`        alias of conversationId in current
 *                        data model; kept for readability
 *  - `status`           last-known status of the CURRENT
 *                        run (see above). A follow-up may
 *                        legitimately take a terminal task
 *                        back to non-terminal (running).
 *  - `lastSeq`          highest event sequence seen for this
 *                        task; used to dedupe replays after
 *                        reconnect
 *  - `createdAt` / `updatedAt`  ms timestamps
 *  - `terminalError`    if status === 'failed', the user
 *                        message captured by the normalizer
 *                        at the time of failure
 */
export interface TaskRecord {
  readonly taskId: string;
  readonly runId: string;
  readonly turnId: string | undefined;
  readonly delivery?: WorkDelivery;
  readonly workspaceId: string;
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly sessionId: string;
  status: TaskStatus;
  lastSeq: number;
  readonly createdAt: number;
  updatedAt: number;
  terminalError: string | undefined;
  /** Authoritative daemon terminal metadata. A daemon may report
   * `completed + partial_success`; preserving that distinction prevents the
   * UI from presenting a timed-out best-effort run as an unconditional win. */
  terminalStatus?: string;
  failureClass?: string;
  resultSummary?: string;
  /** True when the current run is a CONVERSATION (chat) turn
   *  rather than a work-order. Chat runs must NOT gate the Work
   *  composer / Stop control (W-RUN handoff §3.2): the renderer
   *  computes `workBusy` from this so a plain "hello" can't lock
   *  the 任务 pill. Set by startTask / sendMessage. */
  readonly isChat?: boolean;
  /** The snapshotted turn intent (spec §2.3). `conversation`
   *  answers directly and must not execute; `task` is an
   *  explicit work order. Derived from `isChat` at send time
   *  via `intentFromIsChat`; undefined on legacy records —
   *  consumers fall back to `intentFromIsChat(isChat)`. */
  readonly intent?: WorkTurnIntent;
}

/** Generate a fresh, unique run identity. Used by the
 *  runtime instead of deriving runId from taskId: one user
 *  turn → one runId, so a single durable task may have many
 *  distinct runs (a `task.sendMessage` follow-up does NOT
 *  reuse the previous turn's runId). */
export function newRunId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof (crypto as { randomUUID?: () => string }).randomUUID === "function"
  ) {
    return `run:${crypto.randomUUID()}`;
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Derive the stable run identity from a taskId. KEPT ONLY
 *  as a test-fixture shorthand; production code must never
 *  use this to build a run identity, because follow-ups
 *  give one task many runs. */
export function runIdForTask(taskId: string): string {
  return `run:${taskId}`;
}

/** Subscriber callback. Receives the task that changed and
 *  the kind of change. The registry fires this AFTER the
 *  in-memory state has been updated. */
export type TaskChangeKind =
  | "registered"
  | "updated"
  | "removed"
  /** The active binding for a conversation was cleared
   *  (task reached a terminal state). The record still
   *  exists in the history table. */
  | "deactivated";
export type TaskChangeListener = (
  record: TaskRecord,
  kind: TaskChangeKind,
) => void;

export class TaskRegistry {
  private readonly byTaskId = new Map<string, TaskRecord>();
  /** Active (non-terminal) binding per conversation. This is
   *  the ONLY index `getActiveByConversation` consults —
   *  terminal records stay in `byTaskId` for diagnostics but
   *  never shadow a newer run of the same conversation
   *  (M3-P0-01). */
  private readonly activeByConversation = new Map<string, string>();
  private readonly listeners = new Set<TaskChangeListener>();

  /** Register a new task. Throws if a record with the same
   *  taskId already exists with a different conversation
   *  binding — that's a daemon-side reuse / data error
   *  and we don't want to silently overwrite. Non-terminal
   *  registrations atomically take the conversation's active
   *  binding (a conversation runs at most one active Work
   *  task). */
  register(record: TaskRecord): void {
    const existing = this.byTaskId.get(record.taskId);
    if (existing) {
      if (existing.conversationId !== record.conversationId) {
        throw new Error(
          `TaskRegistry: taskId=${record.taskId} already bound to ` +
            `conversationId=${existing.conversationId}; ` +
            `refusing to re-bind to ${record.conversationId}`,
        );
      }
      // Same binding — treat as an update (monotonic; a
      // reconcile re-registering a running task never
      // regresses it to pending).
      this.update(record.taskId, {
        status: record.status,
        lastSeq: record.lastSeq,
        updatedAt: record.updatedAt,
        terminalError: record.terminalError,
        terminalStatus: record.terminalStatus,
        failureClass: record.failureClass,
        resultSummary: record.resultSummary,
      });
      return;
    }
    this.byTaskId.set(record.taskId, record);
    if (!isTerminal(record.status)) {
      this.activeByConversation.set(record.conversationId, record.taskId);
    }
    this.fire(record, "registered");
  }

  /**
   * Begin a follow-up run on an existing durable task
   * (architecture doc §4.3 / §6.1: one task, many runs).
   * `task.sendMessage` continuation turns land here.
   *
   * Unlike `update`, this is the EXPLICIT re-entry point:
   * a task that reached a terminal state is deliberately
   * re-activated (status → `starting`) with a NEW runId /
   * turnId / delivery. The normal monotonic guard in
   * `update` is intentionally bypassed — follow-up is a
   * legitimate terminal → running transition, not a
   * regression. The conversation's active binding is
   * re-acquired so routing back to this task resumes.
   * Throws if the taskId is unknown.
   */
  beginFollowUp(args: {
    taskId: string;
    runId: string;
    turnId?: string;
    /** Preserve the conversation/chat intent across follow-up
     *  runs so the renderer's composer gating stays correct
     *  (W-RUN handoff §3.2). Undefined = leave unchanged. */
    isChat?: boolean;
  }): TaskRecord {
    const r = this.byTaskId.get(args.taskId);
    if (!r) {
      throw new Error(
        `TaskRegistry.beginFollowUp: unknown taskId=${args.taskId}`,
      );
    }
    const mutable = r as {
      runId: string;
      turnId: string | undefined;
      delivery?: WorkDelivery;
      status: TaskStatus;
      lastSeq: number;
      updatedAt: number;
      terminalError: string | undefined;
      terminalStatus?: string;
      failureClass?: string;
      resultSummary?: string;
      isChat?: boolean;
      intent?: WorkTurnIntent;
    };
    mutable.runId = args.runId;
    mutable.turnId = args.turnId;
    mutable.delivery = "follow_up";
    mutable.status = "starting";
    mutable.lastSeq = 0;
    mutable.updatedAt = Date.now();
    mutable.terminalError = undefined;
    mutable.terminalStatus = undefined;
    mutable.failureClass = undefined;
    mutable.resultSummary = undefined;
    if (args.isChat !== undefined) {
      mutable.isChat = args.isChat;
      // Keep the snapshotted intent in lock-step with the
      // legacy `isChat` flag (spec §2.3 compatibility).
      mutable.intent = intentFromIsChat(args.isChat);
    }
    this.activeByConversation.set(r.conversationId, r.taskId);
    this.fire(r, "updated");
    return r;
  }

  /** Patch fields on an existing record. No-op if the
   *  taskId is not known (the registry silently ignores
   *  stale events from a task we've already cleaned up).
   *
   *  Status transitions are MONOTONIC (spec §4.3):
   *    - terminal states never go back to anything;
   *    - running/starting never regress to pending
   *      (a reconcile that reports "pending" for a task we
   *      already see running is stale — keep running);
   *    - writing the same status twice is a side-effect-free
   *      no-op (no listener churn). */
  update(
    taskId: string,
    patch: Partial<
      Pick<
        TaskRecord,
        | "status"
        | "lastSeq"
        | "updatedAt"
        | "terminalError"
        | "terminalStatus"
        | "failureClass"
        | "resultSummary"
      >
    >,
  ): void {
    const r = this.byTaskId.get(taskId);
    if (!r) return;
    let changed = false;
    if (patch.status !== undefined) {
      const next = patch.status;
      if (next !== r.status) {
        if (!isAllowedTransition(r.status, next)) return;
        r.status = next;
        changed = true;
        if (isTerminal(next)) {
          this.clearActiveBindingIfPointsTo(r);
        }
      }
    }
    if (patch.lastSeq !== undefined && patch.lastSeq !== r.lastSeq) {
      r.lastSeq = patch.lastSeq;
      changed = true;
    }
    if (patch.updatedAt !== undefined && patch.updatedAt !== r.updatedAt) {
      r.updatedAt = patch.updatedAt;
      changed = true;
    }
    if (
      patch.terminalError !== undefined &&
      patch.terminalError !== r.terminalError
    ) {
      r.terminalError = patch.terminalError;
      changed = true;
    }
    for (const key of ["terminalStatus", "failureClass", "resultSummary"] as const) {
      if (patch[key] !== undefined && patch[key] !== r[key]) {
        r[key] = patch[key];
        changed = true;
      }
    }
    if (!changed) return; // duplicate write: side-effect-free
    this.fire(r, "updated");
  }

  /** Drop a record entirely. Called when the user dismisses
   *  a task or when refresh recovery re-binds it under a
   *  new conversation. */
  remove(taskId: string): void {
    const r = this.byTaskId.get(taskId);
    if (!r) return;
    this.byTaskId.delete(taskId);
    this.clearActiveBindingIfPointsTo(r);
    this.fire(r, "removed");
  }

  /** Clear the conversation's active binding, but ONLY when
   *  it still points at `record`. A late terminal event from
   *  an old task must never clear the binding of the newer
   *  task that replaced it (spec §4.2). */
  private clearActiveBindingIfPointsTo(record: TaskRecord): void {
    const bound = this.activeByConversation.get(record.conversationId);
    if (bound === record.taskId) {
      this.activeByConversation.delete(record.conversationId);
      this.fire(record, "deactivated");
    }
  }

  get(taskId: string): TaskRecord | undefined {
    return this.byTaskId.get(taskId);
  }

  /** The ACTIVE task bound to a conversation, if any.
   *  Consults only the active binding index — terminal
   *  history records never shadow the current run
   *  (M3-P0-01). */
  getActiveByConversation(conversationId: string): TaskRecord | undefined {
    const taskId = this.activeByConversation.get(conversationId);
    if (taskId === undefined) return undefined;
    const r = this.byTaskId.get(taskId);
    if (!r || isTerminal(r.status)) return undefined;
    return r;
  }

  /** Alias kept for call-site readability: the registry's
   *  conversation lookup is the ACTIVE binding, not a scan
   *  of history. */
  getByConversation(conversationId: string): TaskRecord | undefined {
    return this.getActiveByConversation(conversationId);
  }

  /** All records for a project, in insertion order. Used
   *  by the refresh recovery step (B4) to re-bind non-
   *  terminal tasks after a Desktop reload. */
  listByProject(projectRoot: string): readonly TaskRecord[] {
    const out: TaskRecord[] = [];
    for (const r of this.byTaskId.values()) {
      if (r.projectRoot === projectRoot) out.push(r);
    }
    return out;
  }

  listNonTerminal(projectRoot: string): readonly TaskRecord[] {
    return this.listByProject(projectRoot).filter((r) => !isTerminal(r.status));
  }

  listAll(): readonly TaskRecord[] {
    return Array.from(this.byTaskId.values());
  }

  subscribe(listener: TaskChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fire(record: TaskRecord, kind: TaskChangeKind): void {
    for (const l of this.listeners) {
      try {
        l(record, kind);
      } catch (err) {
        // The registry never lets a bad listener poison the
        // data path. Log and move on.
        // eslint-disable-next-line no-console
        console.error("[TaskRegistry] listener threw:", err);
      }
    }
  }
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Forward rank of the non-terminal states. Transitions
 *  between non-terminal states may only move forward; any
 *  non-terminal state may move to any terminal state; no
 *  terminal state may ever move again (spec §4.3). */
const NON_TERMINAL_RANK: ReadonlyMap<TaskStatus, number> = new Map([
  ["pending", 0],
  ["starting", 1],
  ["running", 2],
  ["paused", 3],
]);

function isAllowedTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true; // caller treats as no-op
  if (isTerminal(from)) return false;
  if (isTerminal(to)) return true;
  // Pause is a reversible execution state, not a terminal or a monotonic
  // lifecycle step. A user follow-up resumes the same daemon run, while the
  // executor may pause it again for another decision.
  if (to === "paused") return true;
  if (from === "paused" && (to === "running" || to === "starting")) return true;
  const a = NON_TERMINAL_RANK.get(from) ?? 0;
  const b = NON_TERMINAL_RANK.get(to) ?? 0;
  return b > a;
}

/** Helper: extract the taskId from a raw `task.event` frame's
 *  payload, or `undefined` if the frame is not a task event
 *  or doesn't carry a taskId. Used by the EventRouter (B2). */
export function extractTaskIdFromFrame(
  frame: { event: string; payload?: unknown },
): string | undefined {
  if (frame.event !== "task.event") return undefined;
  const p = frame.payload;
  if (typeof p !== "object" || p === null) return undefined;
  const taskId = (p as Record<string, unknown>)["taskId"];
  return typeof taskId === "string" ? taskId : undefined;
}
