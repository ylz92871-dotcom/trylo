import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import type { ToolCallRequest, ToolPort } from "../../ports/tools.js";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { createDenyAllPermission } from "./permission.js";
import { turnWiringInput } from "./turn-wiring-input.js";
import { wirePorts } from "./wiring.js";
import { createWorkflowTools } from "../../adapters/tools/workflow-history.js";

const SIGNAL = new AbortController().signal;

function history() {
  const records: SessionRecord[] = [];
  const tools = createWorkspaceTools({ workspaceRoot: process.cwd() });

  function event(turnId: string, kind: string, payload: JsonObject) {
    const sequence = records.length;
    records.push({ formatVersion: "1", sequence, type: "envelope", sessionId: "s", turnId,
      at: "1970-01-01T00:00:00.000Z", payload: { envelope: {
        protocolVersion: "0.0", sequence, eventId: `e${sequence}`, timestamp: "1970-01-01T00:00:00.000Z",
        sessionId: "s", turnId, kind, payload, producerId: "loop", producerSequence: sequence,
      } } });
  }

  async function invoke(name: string, args: JsonObject, turnId = "t1") {
    const call: ToolCallRequest = { name, arguments: args, toolCallId: `call-${records.length}` };
    event(turnId, "tool_use", { ...call });
    const result = await tools.execute(call, SIGNAL);
    assert.equal(result.outcome, "result");
    if (result.outcome === "result") event(turnId, "tool_result", { toolCallId: call.toolCallId, status: "succeeded", value: result.value });
  }

  return { records, invoke, event };
}

function restore(records: readonly SessionRecord[]) {
  const wiring = wirePorts(turnWiringInput({
    text: "Continue the existing work", sessionId: "s", turnId: "t2", correlationId: "c",
    workspaceRoot: process.cwd(), workspaceId: "w", checkpointRoot: "unused",
    providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
    permission: createDenyAllPermission(), format: "stream-json", resumeRecords: records,
    sink: { stdout: () => undefined, stderr: () => undefined }, now: () => 0,
  }, undefined, undefined, undefined));

  assert.equal("code" in wiring, false);

  if ("code" in wiring) throw new Error(wiring.detail);

  return wiring;
}

async function value(tools: ToolPort, name: string, args: JsonObject = {}) {
  const result = await tools.execute({ toolCallId: "query", name, arguments: args }, SIGNAL);
  assert.equal(result.outcome, "result");
  if (result.outcome !== "result") throw new Error("expected a successful tool result");
  return result.value;
}

test("task descriptions, dependencies, claims and next ids survive a new CLI turn", async () => {
  const journal = history();

  await journal.invoke("task_create", { subject: "Implement", description: "Keep the public API", activeForm: "Implementing" });
  await journal.invoke("task_create", { subject: "Verify", description: "Run the migration tests" });
  await journal.invoke("task_update", { taskId: "1", blocks: "2", owner: "worker", claim: true });
  const wiring = restore(journal.records);

  try {
    const first = await value(wiring.ports.tools, "task_get", { taskId: "1" });

    assert.match(JSON.stringify(first), /Keep the public API/);
    assert.match(JSON.stringify(first), /worker/);
    const second = await value(wiring.ports.tools, "task_get", { taskId: "2" });

    assert.match(JSON.stringify(second), /"blockedBy":\["1"\]/);
    const third = await value(wiring.ports.tools, "task_create", { subject: "Deliver", description: "Share verified results" });

    assert.equal((third.task as JsonObject).id, "3");
  } finally { await wiring.close(); }
});

test("goal objective, user pause and token usage survive resume", async () => {
  const journal = history();

  await journal.invoke("create_goal", { objective: "Finish the migration", token_budget: 9000 });
  await journal.invoke("goal_account_tokens", { tokens: 1234 });
  await journal.invoke("goal_user_action", { action: "pause" });
  const wiring = restore(journal.records);

  try {
    const result = await value(wiring.ports.tools, "get_goal");
    assert.deepEqual(result.goal, { objective: "Finish the migration", status: "paused_by_user", tokensUsed: 1234, tokenBudget: 9000, remaining: 7766 });
  } finally { await wiring.close(); }
});

test("todo replacement after resume sees the last durable list", async () => {
  const journal = history();

  await journal.invoke("todo_write", { todos: [{ content: "Verify", status: "in_progress" }] });
  const wiring = restore(journal.records);

  try {
    const result = await value(wiring.ports.tools, "todo_write", { todos: [] });
    assert.equal(result.previousTotal, 1);
  } finally { await wiring.close(); }
});

test("a rejected dependency update cannot partially complete a task", async () => {
  const tools = createWorkspaceTools({ workspaceRoot: process.cwd() });

  await value(tools, "task_create", { subject: "Still pending", description: "Do the work" });
  const rejected = await tools.execute({ toolCallId: "bad", name: "task_update", arguments: {
    taskId: "1", status: "completed", blocks: "missing",
  } }, SIGNAL);

  assert.equal(rejected.outcome, "error");
  assert.equal(((await value(tools, "task_get", { taskId: "1" })).task as JsonObject).status, "pending");
});

test("failed, unanswered, foreign and duplicate results cannot invent workflow progress", async () => {
  const journal = history();

  await journal.invoke("task_create", { subject: "Real task", description: "Retain this task" });
  journal.event("t1", "tool_use", { toolCallId: "failed", name: "task_update", arguments: { taskId: "1", status: "completed" } });
  journal.event("t1", "tool_result", { toolCallId: "failed", status: "failed" });
  journal.event("t1", "tool_use", { toolCallId: "unanswered", name: "task_create", arguments: { subject: "Unfinished", description: "Never committed" } });
  journal.event("other-turn", "tool_result", { toolCallId: "unanswered", status: "succeeded", value: { task: { id: "2" } } });
  journal.event("t1", "tool_result", { toolCallId: "call-0", status: "succeeded", value: { task: { id: "1" } } });
  const tools = createWorkflowTools(journal.records);
  const result = await value(tools, "task_list");

  assert.deepEqual(result.tasks, [{ id: "1", subject: "Real task", status: "pending", blocks: [], blockedBy: [] }]);
});

test("call ids can be reused across turns without replaying external actions", async () => {
  const journal = history();

  for (const [turnId, name, args, result] of [
    ["t1", "task_create", { subject: "One", description: "First" }, { task: { id: "1" } }],
    ["t2", "write_file", { path: "must-not-be-written", content: "unsafe replay" }, {}],
    ["t3", "task_create", { subject: "Two", description: "Second" }, { task: { id: "2" } }],
  ] as const) {
    journal.event(turnId, "tool_use", { toolCallId: "same-id", name, arguments: args });
    journal.event(turnId, "tool_result", { toolCallId: "same-id", status: "succeeded", value: result });
  }

  const result = await value(createWorkflowTools(journal.records), "task_list");

  assert.equal((result.tasks as readonly JsonObject[]).length, 2);
});

test("a committed blocked goal restores its terminal state without replaying refused reports", async () => {
  const journal = history();
  await journal.invoke("create_goal", { objective: "Finish" });
  journal.event("t1", "tool_use", { toolCallId: "blocked", name: "update_goal", arguments: { status: "blocked" } });
  journal.event("t1", "tool_result", { toolCallId: "blocked", status: "succeeded", value: { objective: "Finish", status: "blocked", tokensUsed: 0 } });
  assert.equal((await value(createWorkflowTools(journal.records), "get_goal")).goal !== null, true);
  assert.equal(((await value(createWorkflowTools(journal.records), "get_goal")).goal as JsonObject).status, "blocked");
});

test("malformed committed state fails closed instead of silently starting an empty workflow", async () => {
  const journal = history();
  journal.event("t1", "tool_use", { toolCallId: "bad", name: "create_goal", arguments: { objective: "Finish" } });
  journal.event("t1", "tool_result", { toolCallId: "bad", status: "succeeded", value: { status: "active" } });
  const result = await createWorkflowTools(journal.records).execute({ toolCallId: "query", name: "get_goal", arguments: {} }, SIGNAL);
  assert.equal(result.outcome, "error");
  if (result.outcome === "error") assert.equal(result.code, "workflow_history_invalid");
});

test("older v1 tool envelopes recover arguments from canonical transcript items", async () => {
  const journal = history();

  journal.records.push({ formatVersion: "1", sequence: 0, type: "transcript_item", sessionId: "s", turnId: "t1",
    at: "1970-01-01T00:00:00.000Z", payload: { kind: "tool_call", sequence: 0, name: "task_create", toolCallId: "legacy",
      arguments: { subject: "Legacy", description: "Preserve old journals" } } });
  journal.event("t1", "tool_use", { toolCallId: "legacy", name: "task_create" });
  journal.event("t1", "tool_result", { toolCallId: "legacy", status: "succeeded", value: { task: { id: "1" } } });
  const tools = createWorkflowTools(journal.records);

  assert.equal(((await value(tools, "task_get", { taskId: "1" })).task as JsonObject).description, "Preserve old journals");
});

test("a successful mutation without any durable arguments refuses restoration", async () => {
  const journal = history();
  journal.event("t1", "tool_use", { toolCallId: "legacy", name: "task_create" });
  journal.event("t1", "tool_result", { toolCallId: "legacy", status: "succeeded", value: { task: { id: "1" } } });
  const result = await createWorkflowTools(journal.records).execute({ toolCallId: "query", name: "task_list", arguments: {} }, SIGNAL);
  assert.equal(result.outcome, "error");
});
