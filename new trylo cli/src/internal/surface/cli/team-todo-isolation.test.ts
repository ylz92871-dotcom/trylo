import assert from "node:assert/strict";
import { test } from "node:test";
import { createTodoTools } from "../../adapters/tools/todo/index.js";
import { emptyUsage, type ProviderPort } from "../../ports/provider.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { buildSubagentPorts } from "./wiring-subagent.js";
import type { InteractiveChildResult } from "../../subagent/interactive-worker.js";

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

test("team member todos are separate from the parent and sibling and survive task recovery", async t => {
  const previousTotals: number[] = [];
  let sequence = 0;
  const provider: ProviderPort = { async *stream(request) {
    let user = request.messages.length - 1;
    while (user >= 0 && request.messages[user]?.role !== "user") user -= 1;
    const result = request.messages.slice(user + 1).find(message => message.role === "tool");
    if (result === undefined) {
      yield { type: "tool_call", name: "todo_write", toolCallId: `child-todo-${++sequence}`,
        arguments: { todos: [{ content: "member task", status: "in_progress" }] } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "Member task list updated." };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "usage", usage: emptyUsage() };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const tools = createTodoTools();
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, model: "test",
    callerMessages: undefined, permission: { request: async () => { throw new Error("no independent approval"); },
      awaitDecision: async () => { throw new Error("no independent approval"); } },
    team: { runId: "team-todos", members: ["first", "second"].map(memberId => ({ memberId, baseRole: "worker",
      displayName: memberId, role: { name: "worker", description: "worker" } })) } });
  t.after(async () => { await built.runtime.cancelAll(); });
  const collect = async (id: string) => {
    const result = await built.runtime.settled<InteractiveChildResult>(id);
    assert.equal(result.status, "completed");
    for (const envelope of result.output?.envelopes ?? []) {
      const value = envelope.kind === "tool_result" ? envelope.payload.value : undefined;
      if (isObject(value) && typeof value.previousTotal === "number") {
        previousTotals.push(value.previousTotal);
      }
    }
  };
  const signal = new AbortController().signal;
  const call = (name: string, args: JsonObject) => built.tools.execute({ name, arguments: args, toolCallId: `parent-${++sequence}` }, signal);
  const parentArgs = { todos: [{ content: "parent one", status: "pending" }, { content: "parent two", status: "pending" }] };
  await call("todo_write", parentArgs);
  const spawned = await call("spawn_agent", { agent_type: "worker", member_id: "first", message: "first task" });
  assert.equal(spawned.outcome, "result");
  if (spawned.outcome !== "result") return;
  const task = String(spawned.value.task_id);
  const first = await call("wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
  assert.equal(first.outcome, "result");
  await collect(String(spawned.value.agent_id));
  const sent = await call("send_input", { target: task, message: "follow-up" });
  assert.equal(sent.outcome, "result");
  if (sent.outcome !== "result") return;
  const report = first.outcome === "result" ? (first.value.results as JsonObject)[task] as JsonObject : {};
  await call("wait_agent", { targets: [task], after: { [task]: report.cursor ?? 0 }, timeout_ms: 1000, release_on_ready: true });
  await collect(String(sent.value.agent_id));
  const sibling = await call("spawn_agent", { agent_type: "worker", member_id: "second", message: "second task" });
  assert.equal(sibling.outcome, "result");
  if (sibling.outcome !== "result") return;
  await call("wait_agent", { targets: [String(sibling.value.task_id)], timeout_ms: 1000, release_on_ready: true });
  await collect(String(sibling.value.agent_id));
  const parent = await call("todo_write", parentArgs);
  assert.equal(parent.outcome, "result");
  assert.deepEqual(previousTotals, [0, 1, 0]);
  if (parent.outcome === "result") assert.equal(parent.value.previousTotal, 2);
});
