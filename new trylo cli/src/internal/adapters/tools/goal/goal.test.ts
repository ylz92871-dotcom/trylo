import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoalTools } from "./index.js";
import type { ToolCallRequest } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";

function call(toolCallId: string, name: string, args: JsonObject = {}): ToolCallRequest {
  return { toolCallId, name, arguments: args };
}

function resultValue(outcome: unknown): JsonObject {
  assert.equal((outcome as { outcome: string }).outcome, "result");
  return (outcome as { outcome: "result"; value: JsonObject }).value;
}

function resultOutput(outcome: unknown): string {
  assert.equal((outcome as { outcome: string }).outcome, "result");
  return (outcome as { outcome: "result"; output: string }).output;
}

function errorCode(outcome: unknown): string {
  assert.equal((outcome as { outcome: string }).outcome, "error");
  return (outcome as { outcome: "error"; code: string }).code;
}

test("one unfinished goal at a time; blocked needs three consecutive reports", async () => {
  const port = createGoalTools({ turnId: "turn-1" });
  const signal = new AbortController().signal;
  const created = await port.execute(call("t1", "create_goal", { objective: "Land the migration." }), signal);

  assert.equal(created.outcome, "result");

  const second = await port.execute(call("t2", "create_goal", { objective: "Something else." }), signal);

  assert.equal(second.outcome, "error");

  // B3: the count is kept by the adapter, not supplied by the caller.
  // A single hard turn is difficulty, not an impasse.
  const first = await port.execute(call("t3", "update_goal", { status: "blocked" }), signal);

  assert.equal(errorCode(first), "not_blocked_by_repetition");
  const attempt = await port.execute(call("t4", "update_goal", { status: "blocked" }), signal);

  assert.equal(errorCode(attempt), "not_blocked_by_repetition");
  const blocked = await port.execute(call("t5", "update_goal", { status: "blocked" }), signal);

  assert.equal(blocked.outcome, "result");
  assert.equal(resultValue(blocked)["status"], "blocked");
});

test("the tool takes no caller-supplied count", async () => {
  const port = createGoalTools({ turnId: "turn-1b" });
  const signal = new AbortController().signal;

  await port.execute(call("t1", "create_goal", { objective: "Count the mechanism." }), signal);
  const names = port.snapshot().find((binding) => binding.name === "update_goal");

  assert.ok(names !== undefined);
  const properties = (names.parameters as JsonObject)["properties"] as JsonObject;

  assert.equal("consecutive_blocked_turns" in properties, false);
});

test("budget exhaustion is a pause, never success; resume keeps the objective", async () => {
  const port = createGoalTools({ turnId: "turn-2" });
  const signal = new AbortController().signal;

  await port.execute(call("t1", "create_goal", { objective: "Stay in budget.", token_budget: 100 }), signal);
  const spent = await port.execute(call("t2", "goal_account_tokens", { tokens: 120 }), signal);

  assert.equal(resultValue(spent)["status"], "budget_exhausted");

  const completeAfterBudget = await port.execute(call("t3", "update_goal", { status: "complete" }), signal);

  assert.equal(completeAfterBudget.outcome, "result");

  const fresh = createGoalTools({ turnId: "turn-3" });

  await fresh.execute(call("t1", "create_goal", { objective: "Recover after pause." }), signal);
  await fresh.execute(call("t2", "goal_user_action", { action: "pause" }), signal);
  const resumed = await fresh.execute(call("t3", "goal_user_action", { action: "resume" }), signal);

  assert.equal(resultValue(resumed)["status"], "active");

  const read = await fresh.execute(call("t4", "get_goal"), signal);

  assert.match(resultOutput(read), /Recover after pause/);
});

test("user cancel ends the goal but keeps the record readable", async () => {
  const port = createGoalTools({ turnId: "turn-4" });
  const signal = new AbortController().signal;
  await port.execute(call("t1", "create_goal", { objective: "Exploratory work." }), signal);
  const cancelled = await port.execute(call("t2", "goal_user_action", { action: "cancel" }), signal);
  assert.equal(resultValue(cancelled)["status"], "cancelled");
});
