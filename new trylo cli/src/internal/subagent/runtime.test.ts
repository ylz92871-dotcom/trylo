import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentGovernanceError, SubagentGovernanceTracker } from "./governance.js";
import { SubagentRuntime } from "./runtime.js";
import type { TimerScheduler } from "./scheduler.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";

function createMockTools(): ToolPort {
  return {
    snapshot() {
      return [];
    },
    async execute() {
      return { outcome: "result", value: {}, output: "ok", truncated: false };
    },
    async cancel() {},
  };
}

/**
 * Lets every already-queued promise continuation run.
 *
 * This is a flush, not a sleep: the lifecycle tests below never race the clock,
 * they only need the microtasks a settled promise started to finish before the
 * next assertion.
 */
function flushContinuations(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A scheduler the test fires by hand.
 *
 * A timeout that matters is fired at the moment the test wants it, so no
 * lifecycle case here races real time (WP-CLI-N3 forbids sleep races).
 */
function manualScheduler(): {
  readonly scheduler: TimerScheduler;
  readonly fireAll: () => void;
  readonly pendingCount: () => number;
} {
  const pending = new Set<() => void>();
  return {
    scheduler: (_delayMs, fire) => {
      pending.add(fire);
      return {
        cancel: () => {
          pending.delete(fire);
        },
      };
    },
    fireAll: () => {
      for (const fire of [...pending]) {
        pending.delete(fire);
        fire();
      }
    },
    pendingCount: () => pending.size,
  };
}

/** A worker that ignores its abort signal until the test lets it return. */
function stubbornWorker(): {
  readonly worker: () => Promise<string>;
  readonly finish: () => void;
} {
  let finish: () => void = () => {};
  const alive = new Promise<void>((resolve) => {
    finish = () => {
      resolve();
    };
  });
  return {
    worker: async () => {
      await alive;
      return "late";
    },
    finish: () => {
      finish();
    },
  };
}

/** Spawns and waits one completed subagent, answering its id. */
async function runToCompletion(
  runtime: SubagentRuntime,
  name: string,
  attemptId: string,
): Promise<string> {
  const handle = runtime.spawn({
    name,
    lineage: { parentAgentId: "agent-root", rootAttemptId: attemptId },
    permissions: { allowedTools: [] },
    worker: async () => name,
  });
  const result = await handle.wait();
  assert.equal(result.status, "completed");
  return handle.subagentId;
}

test("SA-1 运行时：spawn 子代理并正常执行完成，带回结果且生命周期事件齐全", async () => {
  const events: Array<{ kind: string; payload: Record<string, unknown>; rootAttemptId: string }> = [];
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
    onEvent: (kind, payload, rootAttemptId) => {
      events.push({ kind, payload, rootAttemptId });
    },
  });

  const handle = runtime.spawn({
    name: "data_processor",
    lineage: {
      parentAgentId: "agent-root",
      rootAttemptId: "att-1",
      toolCallId: "call-1",
    },
    permissions: {
      allowedTools: [],
    },
    worker: async (ctx) => {
      ctx.reportProgress("Processing batch 1", 50);
      return { count: 42, summary: "processed" };
    },
  });

  assert.equal(handle.name, "data_processor");
  assert.equal(handle.status(), "running");

  const result = await handle.wait();
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { count: 42, summary: "processed" });

  // Verify lifecycle events
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "subagent_spawn");
  assert.equal(events[0]?.payload.subagentId, handle.subagentId);
  assert.equal(events[0]?.payload.name, "data_processor");
  assert.equal(events[0]?.payload.toolCallId, "call-1");
  assert.equal(events[0]?.rootAttemptId, "att-1");

  assert.equal(events[1]?.kind, "subagent_end");
  assert.equal(events[1]?.payload.subagentId, handle.subagentId);
  assert.equal(events[1]?.payload.status, "completed");
  assert.equal(events[1]?.payload.toolCallId, "call-1");
  assert.equal(events[1]?.rootAttemptId, "att-1");
});

test("SA-1 运行时：取消正在执行的子代理，中止任务、回收资源、父任务不阻塞", async () => {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
    onEvent: (kind, payload) => {
      events.push({ kind, payload });
    },
  });

  let taskAborted = false;

  const handle = runtime.spawn({
    name: "long_running_worker",
    lineage: {
      parentAgentId: "agent-root",
      rootAttemptId: "att-2",
    },
    permissions: {
      allowedTools: [],
    },
    worker: async (ctx) => {
      return new Promise((_resolve, reject) => {
        if (ctx.signal.aborted) {
          taskAborted = true;
          reject(new Error("aborted"));
          return;
        }
        ctx.signal.addEventListener("abort", () => {
          taskAborted = true;
          reject(new Error("aborted"));
        });
      });
    },
  });

  assert.equal(handle.status(), "running");

  // Give microtask a chance to start the worker
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Cancel while in flight
  const cancelled = await handle.cancel("manual_stop");
  assert.equal(cancelled, true);

  const result = await handle.wait();
  assert.equal(result.status, "cancelled");
  assert.equal(taskAborted, true);
  assert.equal(handle.status(), "cancelled");

  // Verify subagent_end was emitted with status "cancelled"
  const endEvent = events.find((e) => e.kind === "subagent_end");
  assert.ok(endEvent);
  assert.equal(endEvent.payload.status, "cancelled");
});

test("SA-1 运行时：子代理超时自动中止，状态标记为 timed_out", async () => {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
    onEvent: (kind, payload) => {
      events.push({ kind, payload });
    },
  });

  const handle = runtime.spawn({
    name: "timeout_worker",
    lineage: {
      parentAgentId: "agent-root",
      rootAttemptId: "att-3",
    },
    permissions: {
      allowedTools: [],
    },
    governance: {
      timeoutMs: 50,
    },
    worker: async (_ctx) => {
      return new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    },
  });

  const result = await handle.wait();
  assert.equal(result.status, "timed_out");

  const endEvent = events.find((e) => e.kind === "subagent_end");
  assert.ok(endEvent);
  assert.equal(endEvent.payload.status, "timed_out");
});

test("SA-1 运行时：工作逻辑异常安全捕获，状态为 failed 且宿主不崩溃", async () => {
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
  });

  const handle = runtime.spawn({
    name: "failing_worker",
    lineage: {
      parentAgentId: "agent-root",
      rootAttemptId: "att-4",
    },
    permissions: {
      allowedTools: [],
    },
    worker: async () => {
      throw new Error("unhandled_business_error");
    },
  });

  const result = await handle.wait();
  assert.equal(result.status, "failed");
  assert.ok(result.error);
  assert.equal(result.error.message, "unhandled_business_error");
});

test("SA-1 运行时：支持进度监听回调", async () => {
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
  });

  const progressReports: string[] = [];

  const handle = runtime.spawn({
    name: "progress_worker",
    lineage: {
      parentAgentId: "agent-root",
      rootAttemptId: "att-5",
    },
    permissions: {
      allowedTools: [],
    },
    worker: async (ctx) => {
      ctx.reportProgress("step 1", 25);
      ctx.reportProgress("step 2", 75);
      return "done";
    },
  });

  handle.onProgress((p) => {
    progressReports.push(p.message);
  });

  await handle.wait();
  assert.deepEqual(progressReports, ["step 1", "step 2"]);
});

test("a throwing event sink never takes down the subagent it observes", async () => {
  // The sink is the host's observer surface, best-effort by contract: its
  // throw must not abort the run, the journal stays correct, and the
  // subagent reaches its own terminal state. This test is the contract the
  // catch in emitEvent documents.
  let sinkFailures = 0;
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
    onEvent: () => {
      sinkFailures += 1;
      throw new Error("host sink bug");
    },
  });
  const handle = runtime.spawn({
    name: "observed_worker",
    lineage: {
      parentAgentId: "agent-root",
      rootAttemptId: "att-sink",
    },
    permissions: {
      allowedTools: [],
    },
    worker: async (ctx) => {
      ctx.reportProgress("still running", 10);
      return "done";
    },
  });
  const result = await handle.wait();
  assert.equal(result.status, "completed");
  assert.equal(result.status === "completed" ? result.output : undefined, "done");
  assert.ok(sinkFailures >= 2, `the sink was called for spawn and end (got ${sinkFailures})`);
});

/**
 * CLI-01B: the concurrency cap must hold for a worker that ignores its abort.
 *
 * A cancel is a state transition, not a promise that the worker stopped. If the
 * slot is given back when the cancel is *decided* rather than when the worker
 * really returns, "cancel" becomes a way to exceed the cap.
 */
test("CLI-01B 取消不提前释放名额：不响应 Abort 的 worker 继续占名额，上限无法被绕过", async () => {
  const governance = new SubagentGovernanceTracker({ maxConcurrency: 1 });
  const runtime = new SubagentRuntime({ tools: createMockTools(), governance });
  const stubborn = stubbornWorker();

  const handle = runtime.spawn({
    name: "ignores_abort",
    lineage: { parentAgentId: "agent-root", rootAttemptId: "att-cancel-slot" },
    permissions: { allowedTools: [] },
    worker: stubborn.worker,
  });

  await flushContinuations();
  assert.equal(governance.getActiveCount(), 1);

  assert.equal(await handle.cancel("manual_stop"), true);
  assert.equal(handle.status(), "cancelled");

  // The worker has not returned yet, so the slot is still occupied...
  assert.equal(
    governance.getActiveCount(),
    1,
    "the slot must survive a cancel the worker has not honoured",
  );
  // ...and the cap therefore still refuses the next subagent.
  assert.throws(
    () => {
      runtime.spawn({
        name: "second",
        lineage: { parentAgentId: "agent-root", rootAttemptId: "att-cancel-slot-2" },
        permissions: { allowedTools: [] },
        worker: stubborn.worker,
      });
    },
    (err: unknown) =>
      err instanceof SubagentGovernanceError && err.code === "concurrency_limit_exceeded",
  );

  stubborn.finish();
  await flushContinuations();
  assert.equal(governance.getActiveCount(), 0, "the slot comes back when the worker really ends");

  // The worker's late return is not a second terminal: the run was settled once.
  assert.equal(handle.status(), "cancelled");
  assert.equal((await handle.wait()).status, "cancelled");
  assert.equal(
    await handle.cancel("again"),
    false,
    "a second cancel is refused rather than writing a second terminal",
  );
});

/**
 * CLI-01B: an observation timeout is a fact about the waiter, not a task
 * terminal.
 *
 * The waiter below gives up on a worker that never settles, so the timeout is
 * the deterministic winner — this is not a clock race.
 */
test("CLI-01B 观察超时只结束这一次观察：不取消任务，也不冒充任务终态", async () => {
  const runtime = new SubagentRuntime({ tools: createMockTools() });
  const stubborn = stubbornWorker();

  const handle = runtime.spawn({
    name: "slow_worker",
    lineage: { parentAgentId: "agent-root", rootAttemptId: "att-wait-timeout" },
    permissions: { allowedTools: [] },
    worker: stubborn.worker,
  });

  await flushContinuations();
  const observed = await handle.wait(5);

  assert.notEqual(handle.status(), "cancelled", "a waiter's timeout must not cancel the run");
  assert.notEqual(
    observed.status,
    "timed_out",
    "observation timeout must not be reported as the run's terminal state",
  );

  stubborn.finish();
  const settled = await handle.wait();
  assert.equal(settled.status, "completed");
});

/** CLI-01B: a settled subagent must stop holding an active record. */
test("CLI-01B 结束的子代理不再占活动名额，终态仍可从历史查到", async () => {
  const runtime = new SubagentRuntime({ tools: createMockTools() });

  const first = await runToCompletion(runtime, "done_0", "att-retire-0");
  const second = await runToCompletion(runtime, "done_1", "att-retire-1");
  const third = await runToCompletion(runtime, "done_2", "att-retire-2");

  assert.deepEqual(
    runtime.getActiveInstances(),
    [],
    "no settled subagent may still hold an active slot",
  );
  for (const id of [first, second, third]) {
    assert.equal(runtime.status(id), "completed", "a settled terminal stays answerable");
  }
});

/** CLI-01B: the history has a ceiling, so settled runs cannot pile up forever. */
test("CLI-01B 结束历史有上限：超出后最老的终态被丢弃，活动集不受影响", async () => {
  const runtime = new SubagentRuntime({ tools: createMockTools(), historyLimit: 2 });

  const first = await runToCompletion(runtime, "capped_0", "att-capped-0");
  const second = await runToCompletion(runtime, "capped_1", "att-capped-1");
  const third = await runToCompletion(runtime, "capped_2", "att-capped-2");

  assert.equal(runtime.getHistorySize(), 2, "the history honours its ceiling");
  assert.deepEqual(runtime.getActiveInstances(), []);
  assert.equal(runtime.status(third), "completed");
  assert.equal(runtime.status(second), "completed");
  // `first` fell off the ceiling. `status` has no "unknown" answer — it reports
  // the same `failed` it reports for an id it never saw, which is why a caller
  // that needs the terminal keeps the result its own `wait()` returned.
  assert.equal(runtime.status(first), "failed");
});

/**
 * CLI-01B: the execution timeout is armed through the injected scheduler, and
 * it settles the run's state without deciding that the worker stopped.
 */
test("CLI-01B 执行超时：由注入调度器驱动，终态唯一，名额仍由 worker 是否结束决定", async () => {
  const clock = manualScheduler();
  const governance = new SubagentGovernanceTracker({
    maxConcurrency: 1,
    timeoutMs: 1_000,
    scheduler: clock.scheduler,
  });
  const runtime = new SubagentRuntime({ tools: createMockTools(), governance });
  const stubborn = stubbornWorker();

  const handle = runtime.spawn({
    name: "timeout_ignores_abort",
    lineage: { parentAgentId: "agent-root", rootAttemptId: "att-timeout-slot" },
    permissions: { allowedTools: [] },
    worker: stubborn.worker,
  });

  await flushContinuations();
  assert.equal(clock.pendingCount(), 1, "the execution timeout comes from the injected scheduler");

  clock.fireAll();
  await flushContinuations();

  const timedOut = await handle.wait();
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.observed, "terminal");
  // The worker ignored its abort, so the cap still applies to it.
  assert.equal(governance.getActiveCount(), 1);

  stubborn.finish();
  await flushContinuations();
  assert.equal(governance.getActiveCount(), 0);
  assert.equal(handle.status(), "timed_out", "the late return is not a second terminal");
});

/**
 * CLI-01B: every waiter has its own observation, and none of them owns the run.
 */
test("CLI-01B 多 waiter：各自的观察超时互不影响，也不取消任务", async () => {
  const clock = manualScheduler();
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
    // No execution timeout in this case: the subject is the observation timeout.
    governance: new SubagentGovernanceTracker({
      timeoutMs: Number.POSITIVE_INFINITY,
      scheduler: clock.scheduler,
    }),
    scheduler: clock.scheduler,
  });
  const stubborn = stubbornWorker();

  const handle = runtime.spawn({
    name: "two_waiters",
    lineage: { parentAgentId: "agent-root", rootAttemptId: "att-multi-waiter" },
    permissions: { allowedTools: [] },
    worker: stubborn.worker,
  });

  await flushContinuations();
  const firstWaiter = handle.wait(50);
  const secondWaiter = handle.wait(50);
  assert.equal(clock.pendingCount(), 2, "each waiter arms its own timeout");

  clock.fireAll();
  const [firstAnswer, secondAnswer] = await Promise.all([firstWaiter, secondWaiter]);
  assert.equal(firstAnswer.observed, "timeout");
  assert.equal(secondAnswer.observed, "timeout");
  assert.equal(firstAnswer.status, "running");
  assert.equal(handle.status(), "running", "no waiter's timeout cancels the run");

  stubborn.finish();
  const settled = await handle.wait();
  assert.equal(settled.observed, "terminal");
  assert.equal(settled.status, "completed");
});

/**
 * CLI-01B integration: after a cancel, the worker's next tool call is refused
 * before the real tool port is reached.
 *
 * The worker hands each call a *fresh* signal, deliberately: the point is the
 * boundary's own reading of the run's cancellation, not the caller's signal.
 */
test("CLI-01B 集成：取消后 context.tools.execute 被拒，真实工具零派发", async t => {
  const dispatched: string[] = [];
  const readFileBinding: ToolBinding = {
    name: "read_file",
    description: "Read a file",
    sideEffect: "read_only",
    parameters: {},
    needsApproval: false,
    timeoutMs: 1_000,
    outputLimits: { maxBytes: 1_000, maxLines: 100 },
  };
  const tools: ToolPort = {
    snapshot() {
      return [readFileBinding];
    },
    async execute(call: ToolCallRequest): Promise<ToolOutcome> {
      dispatched.push(call.toolCallId);
      return { outcome: "result", value: {}, output: "ok", truncated: false };
    },
    async cancel() {},
  };
  const runtime = new SubagentRuntime({ tools });

  let afterCancel: ToolOutcome | undefined;
  let finish: () => void = () => {};
  const alive = new Promise<void>((resolve) => {
    finish = () => {
      resolve();
    };
  });
  const call = (toolCallId: string): ToolCallRequest => ({
    toolCallId,
    name: "read_file",
    arguments: { path: "a.txt" },
  });

  const handle = runtime.spawn({
    name: "keeps_calling_tools",
    lineage: { parentAgentId: "agent-root", rootAttemptId: "att-integration" },
    permissions: { allowedTools: ["read_file"] },
    worker: async (ctx) => {
      const before = await ctx.tools.execute(call("call-before"), new AbortController().signal);
      assert.equal(before.outcome, "result");
      await alive;
      afterCancel = await ctx.tools.execute(call("call-after"), new AbortController().signal);
      return "done";
    },
  });
  t.after(async () => {
    await handle.cancel("test_cleanup");
    finish();
    await runtime.waitForRetirement(handle.subagentId, 1000, new AbortController().signal);
  });
  const dispatchedId = JSON.stringify([`subagent:${handle.subagentId}`, "call-before"]);

  await flushContinuations();
  assert.deepEqual(dispatched, [dispatchedId]);

  await handle.cancel("integration_stop");
  finish();
  await flushContinuations();

  assert.deepEqual(dispatched, [dispatchedId], "nothing reaches the real tool after the cancel");
  assert.equal(afterCancel?.outcome, "cancelled");
  assert.equal(handle.status(), "cancelled");
});
