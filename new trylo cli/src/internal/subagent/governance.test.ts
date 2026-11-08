import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentGovernanceTracker, SubagentGovernanceError } from "./governance.js";
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

test("SA-4 治理：并发上限硬顶，超出限制直接拒绝，防止派生失控", () => {
  const tracker = new SubagentGovernanceTracker({ maxConcurrency: 2 });

  tracker.allocate("sub-1");
  assert.equal(tracker.getActiveCount(), 1);

  tracker.allocate("sub-2");
  assert.equal(tracker.getActiveCount(), 2);

  // 3rd allocation must be rejected
  assert.throws(
    () => {
      tracker.allocate("sub-3");
    },
    (err: unknown) => {
      return (
        err instanceof SubagentGovernanceError &&
        err.code === "concurrency_limit_exceeded"
      );
    },
  );

  // Release sub-1, then sub-3 can allocate
  tracker.release("sub-1");
  assert.equal(tracker.getActiveCount(), 1);

  tracker.allocate("sub-3");
  assert.equal(tracker.getActiveCount(), 2);

  tracker.dispose();
  assert.equal(tracker.getActiveCount(), 0);
});

test("SA-4 治理：Token 预算硬顶，超额消耗中止子代理，主任务不受牵连", async () => {
  const governance = new SubagentGovernanceTracker({ tokenBudget: 500 });
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
    governance,
  });

  const handle = runtime.spawn({
    name: "token_hungry_worker",
    lineage: {
      parentAgentId: "main-agent",
      rootAttemptId: "att-gov-1",
    },
    permissions: {
      allowedTools: [],
    },
    governance: {
      tokenBudget: 500,
    },
    worker: async (ctx) => {
      // Step 1: consume 200 tokens (allowed)
      ctx.recordUsage(100, 100);

      // Step 2: consume 400 more tokens (total 600 > 500, must trigger budget exhaustion)
      ctx.recordUsage(200, 200);
      return "should_not_reach_here";
    },
  });

  const res = await handle.wait();

  assert.equal(res.status, "failed");
  assert.equal(res.error?.code, "token_budget_exhausted");
  assert.equal(governance.getActiveCount(), 0); // slot cleaned up
});

test("SA-4 治理：后台非阻塞并发，主 Agent 不受子代理耗时阻塞", async () => {
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
  });

  const startTime = Date.now();

  // Spawn 3 parallel subagents that take 100ms each
  const handles = [1, 2, 3].map((i) =>
    runtime.spawn({
      name: `async_worker_${i}`,
      lineage: {
        parentAgentId: "main-agent",
        rootAttemptId: `att-parallel-${i}`,
      },
      permissions: {
        allowedTools: [],
      },
      worker: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { index: i };
      },
    }),
  );

  // Main agent spawn call is non-blocking (returns immediately)
  const spawnDuration = Date.now() - startTime;

  assert.ok(spawnDuration < 50, `Spawn took ${spawnDuration}ms, should be non-blocking (<50ms)`);

  // Await all in parallel
  const results = await Promise.all(handles.map((h) => h.wait()));

  assert.equal(results.length, 3);

  for (const r of results) {
    assert.equal(r.status, "completed");
  }
});

test("SA-4 治理：资源回收健全，取消与终态释放全部计时器与槽位", async () => {
  const governance = new SubagentGovernanceTracker({ maxConcurrency: 5, timeoutMs: 10_000 });
  const runtime = new SubagentRuntime({
    tools: createMockTools(),
    governance,
  });

  const handle = runtime.spawn({
    name: "worker_to_cancel",
    lineage: {
      parentAgentId: "main-agent",
      rootAttemptId: "att-cancel-cleanup",
    },
    permissions: {
      allowedTools: [],
    },
    worker: async (ctx) => {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  });

  assert.equal(governance.getActiveCount(), 1);

  await handle.cancel("early_exit");
  await handle.wait();

  // The slot comes back when the worker has really stopped, not when the cancel
  // was decided (WP-CLI-N3). This worker honours its abort, so that is one
  // continuation away; the flush is not a sleep.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  // Assert slot is released and active count is 0
  assert.equal(governance.getActiveCount(), 0);
});

test("SA-4 缺省状态：未派生子代理时无多余后台计时器与副作用", () => {
  const governance = new SubagentGovernanceTracker();
  assert.equal(governance.getActiveCount(), 0);
  assert.equal(governance.getMaxConcurrency(), 4);
});
