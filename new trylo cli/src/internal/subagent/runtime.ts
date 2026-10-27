import type { ToolPort } from "../ports/tools.js";
import { errorCodeOf } from "../contract/index.js";
import { SubagentGovernanceTracker } from "./governance.js";
import {
  createSubagentToolBoundary,
  guardSubagentAttribution,
  validateSubagentLineage,
} from "./lineage.js";
import { systemTimerScheduler, type TimerScheduler } from "./scheduler.js";
import { observeSettlement } from "./settlement.js";
import { accumulatedBudget } from "./budget-snapshot.js";
import { inheritedGrantView } from "./inherited-authority.js";
import { scopeToolCalls } from "./scoped-tool-calls.js";
import type { SubagentToolActivity } from "../protocol/subagent-activity.js";
import type { SubagentObservation } from "../protocol/subagent-observation.js";
import type {
  SubagentContext,
  SubagentHandle,
  SubagentProgressListener,
  SubagentResult,
  SubagentSpawnRequest,
  SubagentStatus,
  SubagentUsage,
} from "./types.js";

export type SubagentEventSink = (
  kind: string,
  payload: Record<string, unknown>,
  rootAttemptId: string,
) => void;

/**
 * How many finished subagents stay answerable after their slot is given back.
 *
 * Only the history needs a ceiling: the active set is capped by the governance
 * concurrency limit. Past this many terminals the oldest is dropped, so memory
 * does not follow how many subagents a session has ever spawned.
 */
export const SUBAGENT_HISTORY_LIMIT = 64;

export type SubagentRuntimeOptions = {
  readonly tools: ToolPort;
  readonly onEvent?: SubagentEventSink | undefined;
  readonly governance?: SubagentGovernanceTracker | undefined;
  readonly idGenerator?: ((name: string) => string) | undefined;
  /**
   * Where the *observation* timeout comes from. The *execution* timeout is
   * armed by the governance tracker, which carries a scheduler of its own; this
   * one is only used when the runtime creates that tracker, so a caller that
   * injects both owns the pairing.
   */
  readonly scheduler?: TimerScheduler | undefined;
  /** Overrides `SUBAGENT_HISTORY_LIMIT`; mainly so the ceiling is testable. */
  readonly historyLimit?: number | undefined;
};

type ActiveSubagentRecord<T> = {
  readonly subagentId: string;
  readonly name: string;
  readonly request: SubagentSpawnRequest<T>;
  status: SubagentStatus;
  readonly abortController: AbortController;
  readonly progressListeners: Set<SubagentProgressListener>;
  readonly promise: Promise<SubagentResult<T>>;
  resolve: (res: SubagentResult<T>) => void;
  readonly retired: Promise<void>;
  readonly resolveRetired: () => void;
  readonly retirementListeners: Set<() => void>;
  result?: SubagentResult<T> | undefined;
};

let subagentSeq = 0;
/**
 * The shipped id generator, and only that: it is the default of the
 * `idGenerator` seam, which is where ambient randomness and the clock are
 * allowed to appear. Nothing about the lifecycle reads the id — tests inject
 * their own generator so ids are not part of what they assert.
 */
function generateSubagentId(name: string): string {
  subagentSeq += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `sub-${name}-${Date.now().toString(36)}-${subagentSeq}-${rand}`;
}

/** A run that reached one of these never changes state again. */
function isTerminalStatus(status: SubagentStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}

/**
 * Owns the lifecycle of every subagent it spawned.
 *
 * Three facts are kept apart on purpose (WP-CLI-N3), because collapsing them is
 * what let the old code report a cancel as if the worker had stopped:
 *
 *  - the run's **state** — `status`, a terminal once and only once;
 *  - whether the **worker has stopped** — known only when its promise settles,
 *    which a worker that ignores its abort signal decides for itself;
 *  - whether the run still **occupies a governance slot** — released only at
 *    that same moment, so a cancel cannot be used to exceed the concurrency cap.
 *
 * A consequence worth stating: an in-process worker that can never be aborted
 * keeps its slot until it returns. The cap therefore still bounds it, at the
 * price that such a run is never "fully cancelled" — the honest report is the
 * cap plus `NOT_VERIFIED`, not a claim that it stopped.
 */
export class SubagentRuntime {
  private readonly tools: ToolPort;
  private readonly onEvent?: SubagentEventSink | undefined;
  private readonly governance: SubagentGovernanceTracker;
  private readonly idGenerator?: ((name: string) => string) | undefined;
  private readonly scheduler: TimerScheduler;
  private readonly historyLimit: number;
  /** Runs that still hold a governance slot. Bounded by the concurrency cap. */
  private readonly active = new Map<string, ActiveSubagentRecord<unknown>>();
  /** Terminals whose slot came back, oldest first, bounded by `historyLimit`. */
  private readonly history = new Map<string, SubagentResult<unknown>>();

  constructor(options: SubagentRuntimeOptions) {
    this.tools = options.tools;
    this.onEvent = options.onEvent;
    this.scheduler = options.scheduler ?? systemTimerScheduler;
    this.governance =
      options.governance ?? new SubagentGovernanceTracker({ scheduler: this.scheduler });
    this.idGenerator = options.idGenerator;
    this.historyLimit = options.historyLimit ?? SUBAGENT_HISTORY_LIMIT;
  }

  getGovernance(): SubagentGovernanceTracker {
    return this.governance;
  }

  /** Ids of the subagents that still hold a governance slot. */
  getActiveInstances(): ReadonlyArray<string> {
    return Array.from(this.active.keys());
  }

  /** How many terminals are still answerable. Never above the history limit. */
  getHistorySize(): number {
    return this.history.size;
  }

  status(subagentId: string): SubagentStatus {
    const active = this.active.get(subagentId);
    if (active !== undefined) {
      return active.status;
    }
    // A settled terminal stays answerable until the bounded history drops it.
    // An id that was never seen — or was dropped — answers `failed`: this
    // contract has no separate "unknown" state. A caller that owns the handle
    // already holds the terminal `wait()` gave it.
    return this.history.get(subagentId)?.status ?? "failed";
  }

  /**
   * Spawns a background subAgent. Does not block the parent execution.
   */
  spawn<T = unknown>(request: SubagentSpawnRequest<T>): SubagentHandle<T> {
    validateSubagentLineage(request.lineage);

    const subagentId =
      this.idGenerator !== undefined
        ? this.idGenerator(request.name)
        : generateSubagentId(request.name);

    // The slot is taken before anything else exists: a run that cannot be
    // admitted must not build a record, arm a timer, or emit a spawn event.
    const { abortController } = this.governance.allocate(
      subagentId,
      request.governance,
      () => {
        this.handleTimeout(subagentId);
      },
    );

    let resolvePromise!: (res: SubagentResult<T>) => void;
    const promise = new Promise<SubagentResult<T>>((resolve) => {
      resolvePromise = resolve;
    });

    const progressListeners = new Set<SubagentProgressListener>();
    let resolveRetired!: () => void;
    const retired = new Promise<void>(resolve => { resolveRetired = resolve; });

    const record: ActiveSubagentRecord<T> = {
      subagentId,
      name: request.name,
      request,
      status: "pending",
      abortController,
      progressListeners,
      promise,
      resolve: resolvePromise,
      retired,
      resolveRetired,
      retirementListeners: new Set(),
    };

    this.active.set(
      subagentId,
      record as unknown as ActiveSubagentRecord<unknown>,
    );

    // Emit subagent_spawn event (attributed to rootAttemptId)
    const spawnPayload: Record<string, unknown> = {
      ...request.teamMember,
      subagentId,
      name: request.name,
      ...(request.lineage.toolCallId ? { toolCallId: request.lineage.toolCallId } : {}),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.agentType === undefined ? {} : { agentType: request.agentType }),
      canReceiveInput: request.input !== undefined,
      taskId: request.continuation?.taskId ?? subagentId,
      ...(request.continuation === undefined ? {} : { resumedFrom: request.continuation.resumedFrom,
        round: request.continuation.roundOffset + 1, displayName: request.continuation.displayName }),
      budget: accumulatedBudget(this.governance.snapshot(subagentId), request.budgetBefore),
    };
    this.emitEvent("subagent_spawn", spawnPayload, request.lineage.rootAttemptId);

    record.status = "running";
    queueMicrotask(() => {
      void this.executeInBackground(record);
    });

    return {
      subagentId,
      name: request.name,
      lineage: request.lineage,
      status: () => this.status(subagentId),
      cancel: (reason) => this.cancel(subagentId, reason),
      wait: (timeoutMs) => this.wait(subagentId, timeoutMs),
      onProgress: (listener) => {
        progressListeners.add(listener);
        return () => {
          progressListeners.delete(listener);
        };
      },
    };
  }

  /**
   * Cancels an active subagent.
   *
   * This settles the run's *state*. It deliberately does **not** give the
   * governance slot back: a cancel is a request, and treating it as proof that
   * the worker stopped is how a cancel would become a way around the
   * concurrency cap. The slot comes back from `retire()`, in the one place that
   * knows the worker has ended.
   */
  async cancel(subagentId: string, reason = "user_cancel"): Promise<boolean> {
    const record = this.active.get(subagentId);
    if (record === undefined || isTerminalStatus(record.status)) {
      return false;
    }

    record.abortController.abort(reason);
    this.finalize(record, "cancelled", undefined, {
      code: "subagent_cancelled",
      message: `Subagent was cancelled: ${reason}`,
    });

    return true;
  }

  /** Parent shutdown requests cancellation; workers still own slot retirement. */
  async cancelAll(reason = "parent_closed"): Promise<void> {
    for (const id of this.getActiveInstances()) {
      await this.cancel(id, reason);
    }
  }

  /** A terminal state can precede worker cleanup; continuation must wait for both. */
  async waitForRetirement(subagentId: string, timeoutMs: number, signal: AbortSignal): Promise<"ready" | "timeout" | "cancelled"> {
    const record = this.active.get(subagentId);
    return record === undefined ? "ready" : observeSettlement(listener => {
      record.retirementListeners.add(listener);
      return () => { record.retirementListeners.delete(listener); };
    }, timeoutMs, signal, this.scheduler);
  }

  /** Final accounting is known only after an aborted provider finishes unwinding. */
  async settled<T>(subagentId: string): Promise<SubagentResult<T>> {
    const record = this.active.get(subagentId);
    if (record === undefined) return this.wait<T>(subagentId);
    await record.retired;
    return record.result as SubagentResult<T>;
  }

  /**
   * Waits for a subagent's terminal state, or until `timeoutMs` passes.
   *
   * The timeout ends *this observation* and nothing else. The run is not
   * cancelled — a caller that wants it stopped asks for that separately, through
   * `cancel` — and the answer carries `observed: "timeout"` with whatever status
   * the run has at that instant. Reporting the run as `timed_out` here would be
   * a second, contradicting terminal for a run that is still going.
   */
  async wait<T = unknown>(subagentId: string, timeoutMs?: number | undefined): Promise<SubagentResult<T>> {
    const record = this.active.get(subagentId);
    if (record === undefined) {
      const settled = this.history.get(subagentId);
      if (settled !== undefined) {
        return settled as SubagentResult<T>;
      }
      return {
        subagentId,
        name: "unknown",
        status: "failed",
        observed: "terminal",
        error: { code: "not_found", message: `Subagent '${subagentId}' not found` },
        usage: { inputTokens: 0, outputTokens: 0 },
        lineage: { parentAgentId: "unknown", rootAttemptId: "unknown" },
      };
    }

    if (record.result !== undefined) {
      return record.result as SubagentResult<T>;
    }

    if (timeoutMs === undefined || timeoutMs <= 0) {
      return record.promise as Promise<SubagentResult<T>>;
    }

    return new Promise<SubagentResult<T>>((resolve) => {
      const timer = this.scheduler(timeoutMs, () => {
        resolve(this.observe(record) as SubagentResult<T>);
      });
      void record.promise.then((result) => {
        timer.cancel();
        resolve(result as SubagentResult<T>);
      });
    });
  }

  /**
   * The run as this instant sees it, for a waiter that stopped waiting.
   *
   * Deliberately not a terminal: nothing happened to the run.
   */
  private observe<T>(record: ActiveSubagentRecord<T>): SubagentResult<T> {
    return {
      subagentId: record.subagentId,
      name: record.name,
      status: record.status,
      observed: "timeout",
      usage: this.governance.getUsage(record.subagentId),
      lineage: record.request.lineage,
    };
  }

  /**
   * The execution timeout fired. Settles the run's state; the slot stays held
   * until the worker actually stops, exactly as for a cancel.
   */
  private handleTimeout(subagentId: string): void {
    const record = this.active.get(subagentId);
    if (record !== undefined && record.status === "running") {
      this.finalize(record, "timed_out", undefined, {
        code: "subagent_timed_out",
        message: "Subagent execution exceeded timeout limit",
      });
    }
  }

  private emitEvent(kind: string, payload: Record<string, unknown>, rootAttemptId: string): void {
    if (!this.onEvent) {
      return;
    }
    // Lineage is this module's own invariant: a malformed attribution is a
    // bug in the emitter, not in the observer, and it propagates.
    const guarded = guardSubagentAttribution(kind, payload, {
      parentAgentId: "subagent_host",
      rootAttemptId,
    });
    try {
      this.onEvent(guarded.kind, payload, guarded.rootAttemptId);
    } catch (err) {
      // The sink is the host's observer surface and the same best-effort
      // contract as the progress listeners below: its throw must not take
      // down the subagent it observes (this path also runs from timer
      // callbacks, where a rethrow is an unhandled rejection). The envelope
      // is dropped on purpose, with the cause named here — a silent drop
      // would hide a host bug.
      void err;
    }
  }

  /**
   * The one writer of a run's terminal state.
   *
   * Idempotent on purpose: a cancel, the execution timeout, the worker
   * returning, and the worker throwing all arrive here, and whichever arrives
   * first is the answer. That is what stops a late success from reviving a run
   * that was already settled.
   */
  private reportTool(subagentId: string, activity: SubagentToolActivity): void {
    const record = this.active.get(subagentId);
    if (record === undefined || record.request.teamMember === undefined || isTerminalStatus(record.status)) return;
    this.emitEvent("subagent_update", { subagentId, status: "running", activity,
      ...record.request.teamMember,
      ...(record.request.agentType === undefined ? {} : { agentType: record.request.agentType }),
      taskId: record.request.continuation?.taskId ?? subagentId }, record.request.lineage.rootAttemptId);
  }

  private reportObservation(subagentId: string, observation: SubagentObservation): void {
    const record = this.active.get(subagentId);
    if (record === undefined || isTerminalStatus(record.status)) return;
    this.emitEvent("subagent_update", { subagentId, status: "running", observation: { ...observation, round: observation.round + (record.request.continuation?.roundOffset ?? 0) },
      ...record.request.teamMember, round: observation.round + (record.request.continuation?.roundOffset ?? 0),
      ...(record.request.agentType === undefined ? {} : { agentType: record.request.agentType }),
      taskId: record.request.continuation?.taskId ?? subagentId }, record.request.lineage.rootAttemptId);
  }

  reportRound(subagentId: string, update: { readonly status: "running" | "waiting"; readonly round: number;
    readonly prompt?: string; readonly result?: string; readonly displayName?: string }): void {
    const record = this.active.get(subagentId);
    if (record === undefined || isTerminalStatus(record.status)) return;
    this.emitEvent("subagent_update", { subagentId, taskId: record.request.continuation?.taskId ?? subagentId,
      ...record.request.teamMember,
      ...(record.request.agentType === undefined ? {} : { agentType: record.request.agentType }),
      budget: accumulatedBudget(this.governance.snapshot(subagentId), record.request.budgetBefore), ...update }, record.request.lineage.rootAttemptId);
  }

  private finalize<T>(
    record: ActiveSubagentRecord<T>,
    status: SubagentStatus,
    output?: T | undefined,
    error?: { code: string; message: string } | undefined,
  ): void {
    if (isTerminalStatus(record.status)) {
      return;
    }

    record.status = status;
    const usage = this.governance.getUsage(record.subagentId);
    const result: SubagentResult<T> = {
      subagentId: record.subagentId,
      name: record.name,
      status,
      observed: "terminal",
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      usage,
      budget: this.governance.snapshot(record.subagentId),
      lineage: record.request.lineage,
    };
    record.result = result;

    // Emit subagent_end event
    const endPayload: Record<string, unknown> = {
      ...record.request.teamMember,
      ...(record.request.agentType === undefined ? {} : { agentType: record.request.agentType }),
      subagentId: record.subagentId,
      status,
      taskId: record.request.continuation?.taskId ?? record.subagentId,
      budget: accumulatedBudget(this.governance.snapshot(record.subagentId), record.request.budgetBefore),
      ...(status === "completed" && typeof output === "object" && output !== null && "parked" in output && output.parked === true
        ? { parked: true, canReceiveInput: true } : {}),
      ...(typeof output === "object" && output !== null && "output" in output && typeof output.output === "string"
        ? { result: output.output } : {}),
      ...(error === undefined ? {} : { error: error.message }),
      ...(record.request.lineage.toolCallId
        ? { toolCallId: record.request.lineage.toolCallId }
        : {}),
    };
    this.emitEvent("subagent_end", endPayload, record.request.lineage.rootAttemptId);

    // Resolve wait promise
    record.resolve(result);
  }

  /**
   * Runs the worker, then retires the run.
   *
   * The `finally` is the reason a settle is guaranteed even for a worker that
   * never started (a cancel that landed before the first microtask).
   */
  private async executeInBackground<T>(record: ActiveSubagentRecord<T>): Promise<void> {
    try {
      await this.runWorker(record);
    } finally {
      this.retire(record, this.terminalAfterWorkerEnd(record));
    }
  }

  /**
   * Gives the run's governance slot back and files its terminal.
   *
   * The only caller is `executeInBackground`'s `finally`, so the slot is held
   * for exactly as long as the worker is alive.
   */
  private retire<T>(record: ActiveSubagentRecord<T>, terminal: SubagentResult<T>): void {
    const accounted = { ...terminal, usage: this.governance.getUsage(record.subagentId),
      budget: this.governance.snapshot(record.subagentId) };
    record.result = accounted;
    this.active.delete(record.subagentId);
    this.governance.release(record.subagentId);

    this.history.set(record.subagentId, accounted);
    while (this.history.size > this.historyLimit) {
      const oldest = this.history.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.history.delete(oldest);
    }
    record.resolveRetired();
    for (const listener of record.retirementListeners) listener();
    record.retirementListeners.clear();
  }

  /**
   * The terminal a finished run must have.
   *
   * Unreachable in production: every path through `runWorker` settles a
   * terminal, and a cancel or an execution timeout settles one even earlier.
   * It exists because this class promises two things — a waiter is always
   * answered, and a slot is always given back — and a broken invariant must not
   * turn into a hung waiter. Repairing with a typed failure is the lesser evil.
   */
  private terminalAfterWorkerEnd<T>(record: ActiveSubagentRecord<T>): SubagentResult<T> {
    const settled = record.result;
    if (settled !== undefined) {
      return settled;
    }

    this.finalize(record, "failed", undefined, {
      code: "subagent_runtime_error",
      message: "Subagent ended without reaching a terminal state",
    });

    const repaired = record.result;
    if (repaired === undefined) {
      throw new Error("subagent runtime invariant: a finished run must have a terminal");
    }
    return repaired;
  }

  /**
   * Runs the worker and settles this run's terminal.
   *
   * A worker failure is a terminal here, never an exception out of this method.
   */
  private async runWorker<T>(record: ActiveSubagentRecord<T>): Promise<void> {
    if (isTerminalStatus(record.status) || record.abortController.signal.aborted) {
      return;
    }

    const boundedTools = createSubagentToolBoundary(
      scopeToolCalls(this.tools, `subagent:${record.subagentId}`, record.request.continuation?.taskId ?? record.subagentId),
      record.request.permissions,
      record.request.lineage,
      record.abortController.signal,
      record.request.localTools,
    );

    const reportProgress = (message: string, percentage?: number | undefined): void => {
      for (const listener of record.progressListeners) {
        try {
          listener({
            message,
            ...(percentage !== undefined ? { percentage } : {}),
          });
        } catch {
          // Best-effort notification surface: a throwing listener is the
          // observer's bug and must not take down the task it observes.
        }
      }
    };

    const recordUsage = (inputTokens: number, outputTokens: number): SubagentUsage => {
      return this.governance.recordUsage(record.subagentId, inputTokens, outputTokens);
    };

    const context: SubagentContext = {
      subagentId: record.subagentId,
      name: record.name,
      lineage: record.request.lineage,
      signal: record.abortController.signal,
      tools: boundedTools,
      reportProgress,
      reportTool: activity => { this.reportTool(record.subagentId, activity); },
      reportObservation: event => { this.reportObservation(record.subagentId, event); },
      recordUsage,
      setActivity: activity => { this.governance.setActivity(record.subagentId, activity); },
      inheritedGrants: inheritedGrantView(record.request.permissions.inheritedGrants),
      remainingTokens: () => this.governance.snapshot(record.subagentId)?.tokensRemaining ?? 0,
      ...(record.request.input === undefined ? {} : { input: record.request.input }),
    };

    try {
      const output = await record.request.worker(context);
      this.finalize(record, "completed", output);
    } catch (err: unknown) {
      this.finalizeWorkerFailure(record, err);
    }
  }

  /**
   * Turns a worker's throw into the run's terminal.
   *
   * An aborted run has usually been settled already by whoever aborted it, so
   * this mostly has nothing to do; naming the abort reason here is what keeps
   * the reason visible when the worker's rejection is the first thing to arrive.
   */
  private finalizeWorkerFailure<T>(record: ActiveSubagentRecord<T>, err: unknown): void {
    if (record.abortController.signal.aborted) {
      const reason = String(record.abortController.signal.reason);
      if (reason === "subagent_timed_out") {
        this.finalize(record, "timed_out", undefined, {
          code: "subagent_timed_out",
          message: "Subagent exceeded timeout limit",
        });
      } else if (reason === "token_budget_exhausted") {
        this.finalize(record, "failed", undefined, {
          code: "token_budget_exhausted",
          message: "Subagent exceeded token budget",
        });
      } else {
        this.finalize(record, "cancelled", undefined, {
          code: "subagent_cancelled",
          message: `Subagent was cancelled: ${reason}`,
        });
      }
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const code = errorCodeOf(err) ?? "subagent_execution_failed";

    this.finalize(record, "failed", undefined, { code, message });
  }
}
