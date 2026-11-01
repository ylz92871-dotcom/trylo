import type {
  ProgressListener,
  ToolRunnerPort,
  ToolRunnerProgress,
  ToolRunnerResult,
  ToolRunnerStatus,
  ToolRunnerTask,
} from "../ports/tool-runner-port.js";
import { SubagentRuntime } from "./runtime.js";
import { systemTimerScheduler } from "./scheduler.js";
import type { SubagentContext, SubagentHandle } from "./types.js";

/**
 * Default fallback implementation of ToolRunnerPort.
 *
 * Conforms to P05 spec §8:
 * "Default fallback implementation = synchronous execution + progress via observation."
 */
export type FallbackTaskExecutor = (
  task: ToolRunnerTask,
  reportProgress: (progress: ToolRunnerProgress) => void,
  signal: AbortSignal,
) => Promise<unknown>;

/** A submitted task and the one terminal it settles on. */
type RunnerTaskRecord = {
  readonly task: ToolRunnerTask;
  readonly abortController: AbortController;
  readonly listeners: Set<ProgressListener>;
  readonly promise: Promise<ToolRunnerResult>;
  resolve: (result: ToolRunnerResult) => void;
  status: ToolRunnerStatus;
  result?: ToolRunnerResult | undefined;
};

/** A task that reached one of these never changes state again. */
function isTerminalRunnerStatus(status: ToolRunnerStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}

function cancelledTask(taskId: string): ToolRunnerResult {
  return {
    taskId,
    status: "cancelled",
    observed: "terminal",
    error: { code: "task_cancelled", message: "Task was cancelled" },
  };
}

export class DefaultFallbackToolRunner implements ToolRunnerPort {
  private readonly executor: FallbackTaskExecutor;
  private readonly onObservation: ((payload: Record<string, unknown>) => void) | undefined;
  private readonly tasks = new Map<string, RunnerTaskRecord>();

  /**
   * `executor` is optional in the type only because a composition root may read
   * it from configuration. A runner with no executor has nothing to run — the
   * old default echoed `{ executed, input }` back as a `completed` task, which
   * is fabricated success (WP-CLI-N3), so the refusal happens here, at the
   * boundary, instead of being deferred into every task's result.
   */
  constructor(
    executor?: FallbackTaskExecutor | undefined,
    onObservation?: ((payload: Record<string, unknown>) => void) | undefined,
  ) {
    if (executor === undefined) {
      throw new Error(
        "DefaultFallbackToolRunner requires an executor: without one there is no work to run and no result to report",
      );
    }
    this.executor = executor;
    this.onObservation = onObservation;
  }

  async submit(task: ToolRunnerTask): Promise<{ readonly taskId: string }> {
    const abortController = new AbortController();
    const listeners = new Set<ProgressListener>();

    let resolveResult: (result: ToolRunnerResult) => void = () => {};
    const promise = new Promise<ToolRunnerResult>((resolve) => {
      resolveResult = resolve;
    });

    const record: RunnerTaskRecord = {
      task,
      abortController,
      listeners,
      promise,
      resolve: resolveResult,
      status: "running",
    };
    this.tasks.set(task.taskId, record);

    const reportProgress = (progress: ToolRunnerProgress): void => {
      // 1. Send to observation (spec §8 requirement)
      if (this.onObservation !== undefined) {
        this.onObservation({
          component: "tool_runner_observation",
          taskId: progress.taskId,
          percentage: progress.percentage,
          message: progress.message,
          timestamp: progress.timestamp,
        });
      }
      // 2. Notify local progress listeners
      for (const listener of listeners) {
        try {
          listener(progress);
        } catch {
          // Best-effort notification surface: a throwing listener is the
          // observer's bug and must not take down the task it observes.
        }
      }
    };

    void this.run(record, reportProgress);

    return { taskId: task.taskId };
  }

  /**
   * Runs the executor and settles exactly one terminal for the task.
   *
   * `settle` is idempotent, so an executor that ignores its abort signal and
   * returns afterwards cannot revive a task that was already cancelled.
   */
  private async run(
    record: RunnerTaskRecord,
    reportProgress: (progress: ToolRunnerProgress) => void,
  ): Promise<void> {
    const taskId = record.task.taskId;
    try {
      const output = await this.executor(record.task, reportProgress, record.abortController.signal);
      this.settle(record, { taskId, status: "completed", observed: "terminal", output });
    } catch (err: unknown) {
      if (record.abortController.signal.aborted) {
        this.settle(record, cancelledTask(taskId));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.settle(record, {
        taskId,
        status: "failed",
        observed: "terminal",
        error: { code: "task_failed", message },
      });
    }
  }

  /**
   * The one writer of a task's terminal state. Cancel and a late executor
   * result both arrive here; whichever arrives first is the answer.
   */
  private settle(record: RunnerTaskRecord, result: ToolRunnerResult): void {
    if (isTerminalRunnerStatus(record.status)) {
      return;
    }
    record.status = result.status;
    record.result = result;
    record.resolve(result);
  }

  onProgress(taskId: string, listener: ProgressListener): () => void {
    const record = this.tasks.get(taskId);
    if (!record) {
      return () => {};
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  async cancel(taskId: string, _reason?: string | undefined): Promise<boolean> {
    const record = this.tasks.get(taskId);
    if (record === undefined || isTerminalRunnerStatus(record.status)) {
      return false;
    }
    record.abortController.abort();
    this.settle(record, cancelledTask(taskId));
    return true;
  }

  /**
   * Waits for the task's terminal, or until `timeoutMs` passes.
   *
   * Same contract as the subagent runtime's `wait`: the timeout ends the
   * *observation*, not the task. The answer carries `observed: "timeout"` and
   * the task's status at that instant, and the task keeps running.
   */
  async wait(taskId: string, timeoutMs?: number | undefined): Promise<ToolRunnerResult> {
    const record = this.tasks.get(taskId);
    if (record === undefined) {
      return {
        taskId,
        status: "failed",
        observed: "terminal",
        error: { code: "task_not_found", message: `Task '${taskId}' not found` },
      };
    }

    if (timeoutMs === undefined || timeoutMs <= 0) {
      return record.promise;
    }

    return new Promise<ToolRunnerResult>((resolve) => {
      const timer = systemTimerScheduler(timeoutMs, () => {
        resolve({ taskId, status: record.status, observed: "timeout" });
      });
      void record.promise.then((result) => {
        timer.cancel();
        resolve(result);
      });
    });
  }

  async status(taskId: string): Promise<ToolRunnerStatus> {
    const record = this.tasks.get(taskId);
    return record?.status ?? "failed";
  }
}

/**
 * Real executor of ToolRunnerPort backed by SubagentRuntime.
 *
 * Conforms to P05 spec §8:
 * "Real executor = subAgent provided by CLI infrastructure package."
 */
export type SubagentTaskExecutor = (
  task: ToolRunnerTask,
  context: SubagentContext,
) => Promise<unknown>;

export class SubagentToolRunner implements ToolRunnerPort {
  private readonly runtime: SubagentRuntime;
  private readonly taskExecutor: SubagentTaskExecutor;
  private readonly subagentMap = new Map<
    string,
    {
      readonly handle: SubagentHandle;
      readonly taskId: string;
      readonly progressListeners: Set<ProgressListener>;
    }
  >();

  constructor(runtime: SubagentRuntime, taskExecutor?: SubagentTaskExecutor | undefined) {
    if (taskExecutor === undefined) {
      throw new Error("SubagentToolRunner requires an executor: no work can run without one");
    }
    this.runtime = runtime;
    this.taskExecutor = taskExecutor;
  }

  async submit(task: ToolRunnerTask): Promise<{ readonly taskId: string }> {
    const progressListeners = new Set<ProgressListener>();

    const handle = this.runtime.spawn({
      name: task.name,
      lineage: {
        parentAgentId: task.parentAgentId ?? "main-agent",
        rootAttemptId: task.rootAttemptId ?? "att-root",
      },
      permissions: {
        allowedTools: [],
      },
      governance: {
        ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
      },
      worker: (context) => this.taskExecutor(task, context),
    });

    handle.onProgress((p) => {
      const progress: ToolRunnerProgress = {
        taskId: task.taskId,
        ...(p.percentage !== undefined ? { percentage: p.percentage } : {}),
        message: p.message,
        timestamp: new Date().toISOString(),
      };
      for (const listener of progressListeners) {
        try {
          listener(progress);
        } catch {
          // Best-effort notification surface: a throwing listener is the
          // observer's bug and must not take down the task it observes.
        }
      }
    });

    this.subagentMap.set(task.taskId, {
      handle,
      taskId: task.taskId,
      progressListeners,
    });

    return { taskId: task.taskId };
  }

  onProgress(taskId: string, listener: ProgressListener): () => void {
    const entry = this.subagentMap.get(taskId);
    if (!entry) {
      return () => {};
    }
    entry.progressListeners.add(listener);
    return () => {
      entry.progressListeners.delete(listener);
    };
  }

  async cancel(taskId: string, reason?: string | undefined): Promise<boolean> {
    const entry = this.subagentMap.get(taskId);
    if (!entry) {
      return false;
    }
    return entry.handle.cancel(reason);
  }

  async wait(taskId: string, timeoutMs?: number | undefined): Promise<ToolRunnerResult> {
    const entry = this.subagentMap.get(taskId);
    if (!entry) {
      return {
        taskId,
        status: "failed",
        observed: "terminal",
        error: { code: "not_found", message: `Task '${taskId}' not found` },
      };
    }

    const res = await entry.handle.wait(timeoutMs);
    return {
      taskId,
      status: res.status,
      observed: res.observed,
      output: res.output,
      ...(res.error !== undefined ? { error: res.error } : {}),
      usage: res.usage,
    };
  }

  async status(taskId: string): Promise<ToolRunnerStatus> {
    const entry = this.subagentMap.get(taskId);
    if (!entry) {
      return "failed";
    }
    return entry.handle.status();
  }
}
