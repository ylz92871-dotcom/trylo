import assert from "node:assert/strict";
import { test } from "node:test";
import { openGoalSession, parseGoalCommand, type GoalCommand } from "./goal-session.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import { createWorkflowTools, restoredGoal } from "../../adapters/tools/workflow-history.js";

const signal = new AbortController().signal;

test("user edit preserves usage, budget and identity without resuming the goal", async () => {
  const first = await open();

  await first.goal.checkpoint(35);
  await first.goal.finish({ status: "cancelled", finishReason: "user_cancel" }, "pause");
  const edited = await open(parseGoalCommand({ version: 1, action: "edit", objective: "Updated explicit outcome" }), first.records);

  assert.equal(edited.goal.current().objective, "Updated explicit outcome");
  assert.equal(edited.goal.current().status, "paused_by_user");
  assert.equal(edited.goal.current().tokensUsed, 35);
  assert.equal(edited.goal.current().tokenBudget, 100);
  assert.equal(edited.goal.current().createdAtTurn, first.goal.current().createdAtTurn);
  assert.equal(edited.emitted.length, 1);
  assert.throws(() => parseGoalCommand({ version: 1, action: "edit", objective: " " }), /invalid_goal_command/);
  await assert.rejects(open(parseGoalCommand({ version: 1, action: "edit", objective: "No reset", tokenBudget: 50 }), edited.records), /invalid_budget/);
});

async function open(command: GoalCommand = { version: 1, action: "create", objective: "Deliver verified result", tokenBudget: 100 }, prior: readonly SessionRecord[] = [], fail = false) {
  const records: SessionRecord[] = [...prior];
  const emitted: object[] = [];
  let failAppend = fail;
  const session: Pick<SessionPort, "append"> = { async append(record) {
    if (failAppend) return { ok: false, code: "disk_full" };
    records.push({ ...record, formatVersion: "1", sequence: records.length });
    return { ok: true, sequence: records.length - 1 };
  } };
  const goal = await openGoalSession({ command, records, session, sessionId: "s", turnId: `t${records.length}`, now: () => 0, emit: frame => emitted.push(frame) });

  return { goal, records, emitted, failNext: () => { failAppend = true; } };
}

test("managed goal controls are absent and direct model calls cannot mutate them", async () => {
  const { goal } = await open();

  assert.deepEqual(goal.tools.snapshot().map(t => t.name), ["get_goal", "update_goal"]);

  for (const name of ["goal_user_action", "goal_account_tokens", "create_goal"]) {
    const result = await goal.tools.execute({ name, arguments: { action: "cancel", tokens: 0, objective: "wrong" }, toolCallId: name }, signal);
    assert.equal(result.outcome, "error");
  }

  assert.equal(goal.current().status, "active");
});

test("cumulative usage snapshots count once, including a second provider attempt", async () => {
  const { goal } = await open();
  await goal.checkpoint(10, "primary");
  await goal.checkpoint(10, "primary");
  await goal.checkpoint(15, "primary");
  await goal.checkpoint(4, "fallback");
  await goal.checkpoint(4, "fallback");
  assert.equal(goal.current().tokensUsed, 19);
});

test("final billed usage wins over a model completion at the budget boundary", async () => {
  const { goal } = await open();
  await goal.tools.execute({ name: "update_goal", arguments: { status: "complete" }, toolCallId: "done" }, signal);
  await goal.checkpoint(100);
  assert.equal(goal.current().status, "budget_exhausted");
  assert.equal(goal.current().tokensUsed, 100);
});

test("pause and explicit resume preserve original objective, usage and constraints", async () => {
  const first = await open();
  await first.goal.checkpoint(30);
  await first.goal.finish({ status: "cancelled", finishReason: "user_cancel" }, "pause");
  assert.equal(first.goal.current().status, "paused_by_user");
  const next = await open({ version: 1, action: "resume" }, first.records);

  assert.equal(next.goal.current().objective, first.goal.current().objective);
  assert.equal(next.goal.current().tokensUsed, 30);
  assert.equal(next.goal.current().tokenBudget, 100);
  assert.equal(next.goal.current().status, "active");
});

test("exhaustion requires explicit budget refill; refill retains usage", async () => {
  const first = await open();
  await first.goal.checkpoint(110);
  await assert.rejects(open({ version: 1, action: "resume" }, first.records), /goal_budget_refill_required/);
  const next = await open({ version: 1, action: "resume", tokenBudget: 200 }, first.records);
  assert.equal(next.goal.current().tokensUsed, 110);
  await next.goal.checkpoint(10);
  assert.equal(next.goal.current().tokensUsed, 120);
});

test("duplicate blocked reports count once at a boundary, reasons must recur", async () => {
  const { goal } = await open();
  const report = (reason: string) => goal.tools.execute({ name: "update_goal", arguments: { status: "blocked", reason }, toolCallId: "blocked" }, signal);

  for (let i = 0; i < 3; i++) await report("missing_input");

  await goal.checkpoint(1);
  assert.equal(goal.current().blockedRounds, 1);
  await report("network");
  await goal.checkpoint(2);
  assert.equal(goal.current().blockedRounds, 1);
  await report("network");
  await goal.checkpoint(3);
  assert.equal(goal.current().status, "active");
  await report("network");
  await goal.checkpoint(4);
  assert.equal(goal.current().status, "blocked");
});

test("unanswered interruptions and provider failures are system pauses, never success", async () => {
  const { goal } = await open();
  await goal.checkpoint(20);
  await goal.finish({ status: "failed", finishReason: "provider_error" });
  assert.equal(goal.current().status, "paused_by_system");
  assert.equal(goal.current().tokensUsed, 20);
});

test("invalid history and failed checkpoints fail closed", async () => {
  await assert.rejects(open(undefined, [], true), /goal_checkpoint_failed/);
  const first = await open();
  const snapshot = first.records[0]!;
  const bad = { ...snapshot, payload: { version: 1, goal: { objective: "broken" } } };
  await assert.rejects(open({ version: 1, action: "resume" }, [bad]), /invalid_goal_history/);
});

test("snapshot restoration follows final durable facts and rejects malformed command", async () => {
  const { goal, records } = await open();
  await goal.checkpoint(25);
  const restored = restoredGoal(records);
  assert.equal(restored && "tokensUsed" in restored ? restored.tokensUsed : -1, 25);
  assert.equal(goal.current().tokensUsed, 25);
  assert.throws(() => parseGoalCommand({ version: 1, action: "create", objective: "", tokenBudget: -1 }), /invalid_goal_command/);
});

test("ordinary chat cannot resume, account, replace or complete a host-managed goal", async () => {
  const first = await open();
  await first.goal.finish({ status: "cancelled", finishReason: "user_cancel" }, "pause");
  const tools = createWorkflowTools(first.records, "ordinary-chat");

  assert.ok(tools.snapshot().some(t => t.name === "get_goal"));
  assert.ok(!tools.snapshot().some(t => t.name === "update_goal"));

  for (const name of ["goal_user_action", "goal_account_tokens", "create_goal", "update_goal"]) {
    const result = await tools.execute({ name, toolCallId: name, arguments: { action: "resume", tokens: 0, objective: "wrong", status: "complete" } }, signal);
    assert.equal(result.outcome, "error");
  }
});

test("a failed host checkpoint cannot promote model completion or silently reuse uncertain usage", async () => {
  const h = await open();
  const appendEnvelope = (kind: string, payload: import("../../protocol/envelope.js").JsonObject) => h.records.push({ formatVersion: "1", type: "envelope",
    sequence: h.records.length, sessionId: "s", turnId: h.goal.turnId, at: "fixture", payload: { envelope: { producerId: "loop", kind, payload } } });

  appendEnvelope("tool_use", { name: "update_goal", toolCallId: "complete", arguments: { status: "complete" } });
  appendEnvelope("tool_result", { toolCallId: "complete", status: "succeeded", value: { objective: h.goal.current().objective, status: "complete", tokensUsed: 0 } });
  appendEnvelope("usage", { totalTokens: 100 });
  await h.goal.tools.execute({ name: "update_goal", toolCallId: "complete", arguments: { status: "complete" } }, signal);
  h.failNext();
  await assert.rejects(h.goal.checkpoint(100), /goal_checkpoint_failed/);
  const restored = restoredGoal(h.records);

  assert.equal(restored && "status" in restored ? restored.status : "invalid", "paused_by_system");
  assert.equal(restored && "usageUncertain" in restored ? restored.usageUncertain : false, true);
  await assert.rejects(open({ version: 1, action: "resume", tokenBudget: 200 }, h.records), /reconciliation_required/);
});

test("a normal execution boundary resets blocked repetition", async () => {
  const { goal } = await open();
  const report = () => goal.tools.execute({ name: "update_goal", arguments: { status: "blocked", reason: "same" }, toolCallId: "blocked" }, signal);
  await report();
  await goal.checkpoint(1, "t", 1);
  assert.equal(goal.current().blockedRounds, 1);
  await goal.checkpoint(2, "t", 2);
  assert.equal(goal.current().blockedRounds, 0);
  await report();
  await goal.checkpoint(3, "t", 3);
  assert.equal(goal.current().blockedRounds, 1);
});

test("resume rejects a reduced budget and an exhausted goal can still be cancelled", async () => {
  const h = await open();
  await h.goal.checkpoint(90);
  await h.goal.finish({ status: "cancelled", finishReason: "user_cancel" }, "pause");
  await assert.rejects(open({ version: 1, action: "resume", tokenBudget: 95 }, h.records), /invalid_budget/);
  const exhausted = await open();
  await exhausted.goal.checkpoint(110);
  const cancelled = await open({ version: 1, action: "cancel" }, exhausted.records);
  await cancelled.goal.checkpoint(0);
  assert.equal(cancelled.goal.current().status, "cancelled");
});

test("unsettled final-answer usage invalidates an earlier completion snapshot", async () => {
  const h = await open({ version: 1, action: "create", objective: "Finish", tokenBudget: 5 });

  await h.goal.tools.execute({ name: "update_goal", arguments: { status: "complete" }, toolCallId: "done" }, signal);
  await h.goal.checkpoint(4);
  h.records.push({ formatVersion: "1", type: "envelope", sequence: h.records.length, sessionId: "s", turnId: h.goal.turnId, at: "fixture",
    payload: { envelope: { kind: "usage", payload: { totalTokens: 2 } } } });
  h.failNext();
  await assert.rejects(h.goal.checkpoint(6), /goal_checkpoint_failed/);
  const restored = restoredGoal(h.records);

  assert.equal(restored && "status" in restored ? restored.status : "invalid", "paused_by_system");
  assert.equal(restored && "usageUncertain" in restored ? restored.usageUncertain : false, true);
});

test("an uncertain goal may be cancelled and replaced without erasing its history", async () => {
  const h = await open();

  h.records.push({ formatVersion: "1", type: "envelope", sequence: h.records.length, sessionId: "s", turnId: h.goal.turnId, at: "fixture",
    payload: { envelope: { kind: "usage", payload: { totalTokens: 2 } } } });
  await assert.rejects(open({ version: 1, action: "resume" }, h.records), /reconciliation_required/);
  const cancelled = await open({ version: 1, action: "cancel" }, h.records);

  assert.equal(cancelled.goal.current().usageUncertain, true);
  const replacement = await open({ version: 1, action: "create", objective: "New explicit goal" }, cancelled.records);

  assert.equal(replacement.goal.current().objective, "New explicit goal");
  assert.equal(replacement.goal.current().usageUncertain, undefined);
  assert.ok(replacement.records.some(record => record.type === "goal_state" && JSON.stringify(record.payload).includes('"usageUncertain":true')));
});
