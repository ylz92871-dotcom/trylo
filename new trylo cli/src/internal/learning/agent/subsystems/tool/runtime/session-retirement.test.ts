import assert from "node:assert/strict";
import test from "node:test";
import { SubagentRuntime } from "../../../../../subagent/runtime.js";
import { SubagentGovernanceTracker } from "../../../../../subagent/governance.js";
import type { TimerScheduler } from "../../../../../subagent/scheduler.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";
import { retireToolLearningWorkers } from "./session-retirement.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

const flush = () => new Promise<void>(resolve => { setImmediate(resolve); });

function fixture() {
  const timers = new Set<() => void>();
  const scheduler: TimerScheduler = (_milliseconds, fire) => {
    timers.add(fire);
    return { cancel: () => { timers.delete(fire); } };
  };
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "error", code: "no_tools", message: "No execution authority" }),
    cancel: async () => {} }, scheduler, governance: new SubagentGovernanceTracker({ timeoutMs: 0, scheduler }) });
  return { runtime, fireTimers: () => { for (const fire of [...timers]) fire(); } };
}

test("tool session retirement waits for actual delayed finally before funding release or terminal writes", async t => {
  const fx = fixture(), entered = deferred(), cleanupStarted = deferred(), permitCleanup = deferred(), trace: string[] = [];
  const handle = fx.runtime.spawn({ name: "tool-contract-finally", lineage: { parentAgentId: "tool-learning", rootAttemptId: "test-attempt" },
    permissions: { allowedTools: [] }, worker: async context => {
      try {
        entered.resolve();
        await new Promise<void>(resolve => { context.signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
      } finally {
        cleanupStarted.resolve();
        await permitCleanup.promise;
        trace.push("provider_reservation_settled");
      }
    } });

  t.after(async () => {
    permitCleanup.resolve();
    await fx.runtime.cancelAll();
    await fx.runtime.settled(handle.subagentId);
  });
  await entered.promise;
  let ended = false;
  const cleanup = retireToolLearningWorkers(fx.runtime, { timeoutMs: 1000, deadline: new AbortController().signal }).then(() => {
    trace.push("funding_released", "terminal_written");
    ended = true;
  });

  await cleanupStarted.promise;
  await flush();
  assert.equal((await handle.wait()).status, "cancelled", "cancellation already exposed a terminal");
  assert.ok(fx.runtime.getActiveInstances().includes(handle.subagentId), "the finally still owns a real governance slot");
  assert.equal(ended, false);
  assert.deepEqual(trace, []);
  permitCleanup.resolve();
  await cleanup;
  assert.deepEqual(trace, ["provider_reservation_settled", "funding_released", "terminal_written"]);
  assert.deepEqual(fx.runtime.getActiveInstances(), []);
  // Per-job retirement leaves this runtime usable for the next separately bounded job.
  const next = fx.runtime.spawn({ name: "later-tool-job", lineage: { parentAgentId: "tool-learning", rootAttemptId: "next-attempt" },
    permissions: { allowedTools: [] }, worker: async () => "no model call" });

  await fx.runtime.settled(next.subagentId);
  assert.equal((await next.wait()).status, "completed");
});

test("a cancelled worker which has not retired stays unconfirmed at the shared deadline", async t => {
  const fx = fixture(), entered = deferred(), permitCleanup = deferred();
  const handle = fx.runtime.spawn({ name: "uncooperative-tool-worker", lineage: { parentAgentId: "tool-learning", rootAttemptId: "timeout-attempt" },
    permissions: { allowedTools: [] }, worker: async () => {
      entered.resolve();
      await permitCleanup.promise;
    } });

  t.after(async () => {
    permitCleanup.resolve();
    await fx.runtime.cancelAll();
    await fx.runtime.settled(handle.subagentId);
  });
  await entered.promise;
  const cleanup = retireToolLearningWorkers(fx.runtime, { timeoutMs: 1000, deadline: new AbortController().signal });

  await flush();
  fx.fireTimers();
  await assert.rejects(cleanup, error => error instanceof ToolLearningServiceError && error.code === "tool_session_retirement_unconfirmed");
  assert.ok(fx.runtime.getActiveInstances().includes(handle.subagentId));
  permitCleanup.resolve();
  await fx.runtime.settled(handle.subagentId);
});
