import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRunnerPort, ToolRunnerProgress, ToolRunnerTask } from "../ports/tool-runner-port.js";
import { DefaultFallbackToolRunner, SubagentToolRunner } from "./tool-runner.js";
import { SubagentRuntime } from "./runtime.js";
import type { ToolPort } from "../ports/tools.js";

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

test("SA-3 ToolRunnerPort 降级执行器：同步执行 + 进度走 observation 语义成立", async () => {
  const observations: Array<Record<string, unknown>> = [];
  const runner: ToolRunnerPort = new DefaultFallbackToolRunner(
    async (task, reportProgress) => {
      reportProgress({
        taskId: task.taskId,
        percentage: 50,
        message: "halfway",
        timestamp: "2026-09-17T00:00:00.000Z",
      });
      return { refinedDescription: "better doc", tool: task.input.tool };
    },
    (obs) => {
      observations.push(obs);
    },
  );

  const task: ToolRunnerTask = {
    taskId: "task-fb-1",
    name: "refine_description",
    input: { tool: "fetch_repo" },
  };

  const localProgress: ToolRunnerProgress[] = [];
  const { taskId } = await runner.submit(task);
  assert.equal(taskId, "task-fb-1");

  runner.onProgress(taskId, (p) => {
    localProgress.push(p);
  });

  const res = await runner.wait(taskId);
  assert.equal(res.status, "completed");
  assert.deepEqual(res.output, { refinedDescription: "better doc", tool: "fetch_repo" });

  // Verify progress went to observation (P05 spec §8 requirement)
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.component, "tool_runner_observation");
  assert.equal(observations[0]?.message, "halfway");
  assert.equal(observations[0]?.percentage, 50);

  const status = await runner.status(taskId);
  assert.equal(status, "completed");
});

test("SA-3 ToolRunnerPort 降级执行器：取消语义成立", async () => {
  const runner: ToolRunnerPort = new DefaultFallbackToolRunner(
    async (_task, _progress, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    },
  );

  const task: ToolRunnerTask = {
    taskId: "task-cancel-1",
    name: "slow_worker",
    input: {},
  };

  await runner.submit(task);
  const cancelled = await runner.cancel("task-cancel-1");
  assert.equal(cancelled, true);

  const res = await runner.wait("task-cancel-1");
  assert.equal(res.status, "cancelled");
  assert.equal(await runner.status("task-cancel-1"), "cancelled");
});

test("SA-3 ToolRunnerPort 子代理执行器：基于真实 SubagentRuntime 后台运行并带回结果", async () => {
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
  });

  const runner: ToolRunnerPort = new SubagentToolRunner(runtime, async (_task, ctx) => {
    ctx.reportProgress("generating code", 30);
    return { artifact: "script.py", lines: 15 };
  });

  const task: ToolRunnerTask = {
    taskId: "task-sa-1",
    name: "crystallize_trajectory",
    input: { session: "ses-10" },
    parentAgentId: "main-orchestrator",
    rootAttemptId: "att-crystallize",
  };

  const progressEvents: ToolRunnerProgress[] = [];
  const { taskId } = await runner.submit(task);
  assert.equal(taskId, "task-sa-1");

  runner.onProgress(taskId, (p) => {
    progressEvents.push(p);
  });

  const res = await runner.wait(taskId);
  assert.equal(res.status, "completed");
  assert.deepEqual(res.output, { artifact: "script.py", lines: 15 });
  assert.equal(await runner.status(taskId), "completed");
});

test("SA-3 ToolRunnerPort 契约一致性与可替换性：降级与真执行器满足同一端口接口", async () => {
  async function runWorkflow(port: ToolRunnerPort, taskId: string): Promise<string> {
    await port.submit({
      taskId,
      name: "worker",
      input: { data: 100 },
    });
    const result = await port.wait(taskId);
    return result.status;
  }

  // 1. Run with DefaultFallbackToolRunner. Its executor is required now — a
  //    runner with nothing to run must refuse rather than report success — so
  //    this arm supplies the echo the old default used to fabricate.
  const fallbackRunner = new DefaultFallbackToolRunner(async (task) => ({
    executed: task.name,
    input: task.input,
  }));
  const res1 = await runWorkflow(fallbackRunner, "wf-1");
  assert.equal(res1, "completed");

  // 2. Run with SubagentToolRunner
  const runtime = new SubagentRuntime({ tools: createMockTools() });
  const subagentRunner = new SubagentToolRunner(runtime, async (task) => ({
    executed: task.name,
    input: task.input,
  }));
  const res2 = await runWorkflow(subagentRunner, "wf-2");
  assert.equal(res2, "completed");
});

/**
 * Lets every already-queued promise continuation run. A flush, not a sleep.
 */
function flushContinuations(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * CLI-01B: a task with no executor must be refused, not echoed back as success.
 *
 * The old default executor answered `{ executed, input }` without doing
 * anything, so a runner that was never given a way to run anything still
 * reported `completed`. That is a fabricated success, and it is the shape the
 * 2026-09 tooling landmines had.
 */
test("CLI-01B 降级执行器：没有执行器时必须拒绝构造，不得回显假成功", () => {
  assert.throws(
    () => {
      new DefaultFallbackToolRunner();
    },
    /executor/i,
  );
});

test("工具演化后台执行器：没有执行器时必须拒绝构造，不得回显假成功", () => {
  const runtime = new SubagentRuntime({ tools: createMockTools() });
  assert.throws(() => new SubagentToolRunner(runtime), /executor/i);
});

/**
 * CLI-01B: a late executor result must not revive a settled task.
 *
 * The executor below ignores its abort signal and returns after the cancel, so
 * the cancel is the only thing that decided the task's state.
 */
test("CLI-01B 降级执行器：取消后执行器迟到成功不得复活已结算任务", async () => {
  let finishExecutor: () => void = () => {};
  const alive = new Promise<void>((resolve) => {
    finishExecutor = () => {
      resolve();
    };
  });
  const runner: ToolRunnerPort = new DefaultFallbackToolRunner(async () => {
    await alive;
    return "late";
  });

  await runner.submit({ taskId: "task-late", name: "late_worker", input: {} });
  await flushContinuations();
  assert.equal(await runner.cancel("task-late"), true);

  finishExecutor();
  await flushContinuations();

  const res = await runner.wait("task-late");
  assert.equal(res.status, "cancelled", "a late executor result must not revive a cancelled task");
  assert.equal(await runner.status("task-late"), "cancelled");
});

/**
 * CLI-01B: a task's wait can time out; the task itself does not.
 *
 * The executor below never settles, so the timeout is the deterministic winner
 * here — this is not a clock race.
 */
test("CLI-01B 降级执行器：观察超时只结束这一次等待，任务继续跑", async () => {
  let finishExecutor: () => void = () => {};
  const alive = new Promise<void>((resolve) => {
    finishExecutor = () => {
      resolve();
    };
  });
  const runner: ToolRunnerPort = new DefaultFallbackToolRunner(async () => {
    await alive;
    return "late";
  });

  await runner.submit({ taskId: "task-slow", name: "slow_worker", input: {} });
  await flushContinuations();

  const observed = await runner.wait("task-slow", 5);
  assert.equal(observed.observed, "timeout");
  assert.equal(observed.status, "running");
  assert.equal(await runner.status("task-slow"), "running", "the wait gave up, not the task");

  finishExecutor();
  await flushContinuations();
  const settled = await runner.wait("task-slow");
  assert.equal(settled.observed, "terminal");
  assert.equal(settled.status, "completed");
});
