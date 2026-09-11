// Trylo Work — TaskReconciler.
//
// v1.16.5+ (W-RUN-004, Phase B3 of the M1 lifecycle
// milestone): event streams are real-time feedback; the
// daemon's authoritative state lives in its task.get /
// task.list responses. The previous App.tsx code treated
// event names like `execution_run_summary` as the SOLE
// signal of completion, which is fragile (a cowork build
// that renames the event, or a missed broadcast, leaves
// the user staring at a forever-pending task).
//
// The reconciler is a small polling loop: for every
// non-terminal task in the registry, periodically call
// `task.get`. When the daemon reports a terminal status,
// the registry is updated, the loop removes the task from
// its active set, and a `terminal` callback fires so the
// renderer can push a "Done" / "Failed" / "Cancelled"
// notice to the right conversation.
//
// Implementation choices:
//   - Polling, not event-driven: the daemon's task.* events
//     do not include a `task.completed` / `task.failed`
//     broadcast on every build (see codex W-RUN-004 + the
//     `task-event-bridge-contract.ts` allowlist — no
//     completion event in the list). The only
//     authoritative signal is the database-backed
//     `task.get`.
//   - Default poll interval 5s: cheap, fast enough that
//     the user sees the terminal state within ~5s of the
//     daemon finishing.
//   - One Promise chain, not a setInterval: a setInterval
//     would fire even when the previous poll is in flight
//     under load. The chain pattern naturally serializes.
//   - Backoff on transient errors: if task.get throws,
//     the next poll is delayed by min(2x, 30s).

import type { ControlPlaneClient } from "./control-plane/types.js";
import {
  isTerminal,
  type TaskRegistry,
  type TaskStatus,
} from "./task-registry.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

/** Map from the cowork task.status string to our
 *  TaskStatus. The reconciler only acts when the daemon
 *  status is terminal; intermediate values (e.g.
 *  'planning', 'executing') are reflected as 'running'.
 *  Exported so refresh recovery (reconcileProject)
 *  registers the real status instead of a blanket
 *  'pending' (M3-P0-02). */
export function mapDaemonStatus(daemon: string | undefined): TaskStatus | undefined {
  if (typeof daemon !== "string") return undefined;
  switch (daemon) {
    case "pending":
    case "queued":
      return "pending";
    case "planning":
    case "starting":
    case "running":
    case "executing":
      return "running";
    case "paused":
    case "awaiting_input":
    case "awaiting_user_input":
      return "paused";
    case "completed":
    case "succeeded":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return undefined;
  }
}

/** Payload of `task.get` we care about. We only read
 *  fields; we never hand the raw payload to the UI. */
interface TaskGetPayload {
  task?: {
    id?: string;
    status?: string;
    updatedAt?: number;
    failure?: { message?: string };
    error?: string | null;
    terminalStatus?: string;
    failureClass?: string;
    resultSummary?: string;
    bestKnownOutcome?: { resultSummary?: string };
  };
}

export interface ReconcilerOptions {
  readonly client: ControlPlaneClient;
  readonly registry: TaskRegistry;
  readonly pollIntervalMs?: number;
  /** Called when the reconciler confirms a terminal state
   *  for a task. The renderer uses this to push the
   *  "Done" / "Failed" notice into the right
   *  conversation. */
  readonly onTerminal?: (record: import("./task-registry.js").TaskRecord) => void;
}

export class TaskReconciler {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeDelay: (() => void) | null = null;
  private readonly pollIntervalMs: number;
  private readonly client: ControlPlaneClient;
  private readonly registry: TaskRegistry;
  private readonly onTerminal?:
    | ((
        record: import("./task-registry.js").TaskRecord,
      ) => void)

  constructor(opts: ReconcilerOptions) {
    this.client = opts.client;
    this.registry = opts.registry;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onTerminal = opts.onTerminal;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    // Do not make Desktop shutdown/mode switches wait for a 5-30 second
    // polling backoff. Wake the serialized loop immediately.
    this.wakeDelay?.();
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // loop swallows its own errors; this is just to
        // ensure the promise settles before we return.
      }
      this.loopPromise = null;
    }
  }

  private async loop(): Promise<void> {
    let backoff = INITIAL_BACKOFF_MS;
    while (this.running) {
      const nonTerminal = this.registry.listAll().filter((r) => !isTerminal(r.status));
      if (nonTerminal.length === 0) {
        await this.delay(this.pollIntervalMs);
        continue;
      }
      let anyError = false;
      for (const r of nonTerminal) {
        if (!this.running) break;
        try {
          const res = (await this.client.send("task.get", {
            taskId: r.taskId,
          })) as TaskGetPayload;
          const task = res?.task;
          const mapped = mapDaemonStatus(task?.status);
          if (mapped === undefined) continue;
          // A follow-up reuses the same durable daemon task. Immediately
          // after task.sendMessage is acknowledged there is a short window
          // where task.get can still return the PREVIOUS turn's terminal
          // row, before the deferred executor emits its first `executing`
          // event. Treating that stale row as the new run's terminal makes
          // every later event look late and leaves the UI frozen while the
          // daemon continues working. The first accepted event advances
          // lastSeq/status, after which terminal task.get is authoritative
          // again.
          if (
            isTerminal(mapped) &&
            r.delivery === "follow_up" &&
            r.status === "starting" &&
            r.lastSeq === 0
          ) {
            continue;
          }
          const terminalError =
            typeof task?.failure?.message === "string"
              ? task.failure.message
              : typeof task?.error === "string"
                ? task.error
                : undefined;
          const resultSummary =
            typeof task?.resultSummary === "string" && task.resultSummary.trim()
              ? task.resultSummary
              : typeof task?.bestKnownOutcome?.resultSummary === "string"
                ? task.bestKnownOutcome.resultSummary
                : undefined;
          const changedStatus = mapped !== r.status;
          // Keep polling idempotent.  Updating the local timestamp on every
          // task.get response notified the whole renderer every five seconds
          // even when the daemon state was unchanged, which amplified the
          // apparent Work UI stalls.  Prefer the daemon revision and only
          // synthesize a time when an actual status transition occurred.
          const authoritativeUpdatedAt =
            typeof task?.updatedAt === "number"
              ? task.updatedAt
              : changedStatus
                ? Date.now()
                : r.updatedAt;
          this.registry.update(r.taskId, {
            status: mapped,
            updatedAt: authoritativeUpdatedAt,
            ...(terminalError ? { terminalError } : {}),
            ...(typeof task?.terminalStatus === "string"
              ? { terminalStatus: task.terminalStatus }
              : {}),
            ...(typeof task?.failureClass === "string"
              ? { failureClass: task.failureClass }
              : {}),
            ...(resultSummary ? { resultSummary } : {}),
          });
          if (changedStatus && isTerminal(mapped)) {
            this.onTerminal?.(r);
          }
          anyError = false;
          backoff = INITIAL_BACKOFF_MS;
        } catch (err) {
          anyError = true;
          // eslint-disable-next-line no-console
          console.error(
            `[TaskReconciler] task.get(${r.taskId}) failed:`,
            err,
          );
        }
      }
      await this.delay(anyError ? Math.min(backoff *= 2, MAX_BACKOFF_MS) : this.pollIntervalMs);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeDelay === finish) this.wakeDelay = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeDelay = finish;
      if (!this.running) finish();
    });
  }
}
