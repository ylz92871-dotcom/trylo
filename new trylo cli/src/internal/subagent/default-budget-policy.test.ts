import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentGovernanceTracker } from "./governance.js";
import { isSubagentBudgetSnapshot } from "../protocol/subagent-budget.js";

test("ordinary subagents have usage facts without an implicit token budget or deadline", () => {
  const timers: number[] = [];
  const tracker = new SubagentGovernanceTracker({ scheduler: delay => {
    timers.push(delay);
    return { cancel() {} };
  } });
  const allocation = tracker.allocate("long-task");

  try {
    assert.deepEqual(timers, []);
    tracker.recordUsage("long-task", 200_000, 100_000);
    assert.equal(allocation.abortController.signal.aborted, false);
    const snapshot = tracker.snapshot("long-task");

    assert.equal(snapshot?.tokensUsed, 300_000);
    assert.equal(snapshot?.tokenLimit, undefined);
    assert.equal(snapshot?.timeoutMs, undefined);
    assert.ok(isSubagentBudgetSnapshot(JSON.parse(JSON.stringify(snapshot))));
  } finally { tracker.dispose(); }
});

test("explicit subagent limits still arm a deadline and enforce the caller's budget", () => {
  const timers: number[] = [];
  const tracker = new SubagentGovernanceTracker({ scheduler: delay => {
    timers.push(delay);
    return { cancel() {} };
  } });
  const allocation = tracker.allocate("limited", { tokenBudget: 50, timeoutMs: 600_000 });

  try {
    assert.deepEqual(timers, [600_000]);
    assert.throws(() => tracker.recordUsage("limited", 30, 21), /exceeded token budget/);
    assert.equal(allocation.abortController.signal.aborted, true);
  } finally { tracker.dispose(); }
});
