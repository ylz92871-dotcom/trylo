import assert from "node:assert/strict";
import { test } from "node:test";
import { createTodoTools } from "./index.js";
import { createWorkflowTools } from "../workflow-history.js";
import { createWorkspaceTools } from "../index.js";
import type { ToolOutcome, ToolPort } from "../../../ports/tools.js";
import type { SessionRecord } from "../../../ports/session.js";
import type { JsonObject } from "../../../protocol/envelope.js";

const SIGNAL = new AbortController().signal;
const TODOS = [{ content: "Keep the completed inspection", status: "completed" },
  { content: "Deliver the remaining artifact", status: "in_progress", activeForm: "Delivering the artifact" }];

async function invoke(tools: ToolPort, name: string, args: JsonObject = {}): Promise<Extract<ToolOutcome, { outcome: "result" }>> {
  const outcome = await tools.execute({ toolCallId: "query", name, arguments: args }, SIGNAL);
  assert.equal(outcome.outcome, "result");
  if (outcome.outcome !== "result") throw new Error("Expected a successful local tool result");
  return outcome;
}

test("todo_read is mounted as a read-only approval-free query and reports an empty list honestly", async () => {
  const tools = createTodoTools();
  const binding = tools.snapshot().find(item => item.name === "todo_read");

  assert.ok(binding);
  assert.equal(binding.sideEffect, "read_only");
  assert.equal(binding.needsApproval, false);
  const result = await invoke(tools, "todo_read");

  assert.deepEqual(result.value, { todos: [], counts: { total: 0, completed: 0, inProgress: 0, pending: 0 } });
  assert.match(result.output, /empty/i);
  assert.doesNotMatch(result.output, /cleared/i);
});

test("reading preserves the current list and subsequent writes remain visible", async () => {
  const tools = createTodoTools();

  await invoke(tools, "todo_write", { todos: TODOS });
  const first = await invoke(tools, "todo_read");

  assert.deepEqual(first.value.todos, TODOS);
  assert.deepEqual(JSON.parse(first.output), first.value, "Model-visible output must retain content as well as activeForm");
  assert.deepEqual((await invoke(tools, "todo_read")).value, first.value);
  assert.equal("previousTotal" in first.value, false);
  const written = await invoke(tools, "todo_write", { todos: [{ content: "Final item", status: "pending" }] });

  assert.equal(written.value.previousTotal, 2, "Reading must not clear or replace the owner state");
  assert.deepEqual((await invoke(tools, "todo_read")).value.todos, [{ content: "Final item", status: "pending" }]);
});

test("todo_read rejects mutation arguments without changing the list", async () => {
  const tools = createTodoTools();
  await invoke(tools, "todo_write", { todos: TODOS });
  const rejected = await tools.execute({ toolCallId: "bad", name: "todo_read", arguments: { todos: [] } }, SIGNAL);
  assert.equal(rejected.outcome, "error");
  assert.deepEqual((await invoke(tools, "todo_read")).value.todos, TODOS);
});

test("a compacted durable workflow restores a readable list without rewriting its journal", async () => {
  const records: SessionRecord[] = [
    { formatVersion: "1", sequence: 0, type: "envelope", sessionId: "s", turnId: "t1", at: "1970-01-01T00:00:00.000Z",
      payload: { envelope: { kind: "tool_use", producerId: "loop", payload: { toolCallId: "todo", name: "todo_write", arguments: { todos: TODOS } } } } },
    { formatVersion: "1", sequence: 1, type: "envelope", sessionId: "s", turnId: "t1", at: "1970-01-01T00:00:00.000Z",
      payload: { envelope: { kind: "tool_result", producerId: "loop", payload: { toolCallId: "todo", status: "succeeded", value: { todos: TODOS } } } } },
    { formatVersion: "1", sequence: 2, type: "compact", sessionId: "s", at: "1970-01-01T00:00:00.000Z",
      payload: { windowId: "w1", replacedFromSequence: 0, replacedToSequence: 1, summary: "Earlier inspection completed.", formatVersion: "1" } },
  ];
  const original = JSON.stringify(records);
  const tools = createWorkflowTools(records, "t2");

  assert.deepEqual((await invoke(tools, "todo_read")).value.todos, TODOS);
  assert.equal(JSON.stringify(records), original, "A read cannot append mutations or replace durable history");
  const written = await invoke(tools, "todo_write", { todos: [] });

  assert.equal(written.value.previousTotal, 2);
});

test("workspace catalog discovery and dispatch expose the same todo_read owner", async () => {
  const tools = createWorkspaceTools({ workspaceRoot: "/local-todo-read" });
  assert.ok(tools.snapshot().some(binding => binding.name === "todo_read"));
  await invoke(tools, "todo_write", { todos: TODOS });
  assert.deepEqual((await invoke(tools, "todo_read")).value.todos, TODOS);
});
