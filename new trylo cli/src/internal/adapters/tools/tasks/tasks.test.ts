import assert from "node:assert/strict";
import { test } from "node:test";
import { createPersistentTaskTools } from "./index.js";
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

async function create(port: ReturnType<typeof createPersistentTaskTools>, subject: string): Promise<string> {
  const signal = new AbortController().signal;
  const made = await port.execute(
    call(`c-${subject}`, "task_create", { subject, description: `${subject} work` }),
    signal,
  );
  const task = resultValue(made)["task"];

  assert.equal(typeof task, "object");
  const id = (task as JsonObject)["id"];

  assert.equal(typeof id, "string");

  return id as string;
}

test("create, get, update, and list keep one id space that never repeats", async () => {
  const port = createPersistentTaskTools();
  const signal = new AbortController().signal;
  const first = await create(port, "first");
  const second = await create(port, "second");

  assert.equal(first, "1");
  assert.equal(second, "2");

  const got = await port.execute(call("g1", "task_get", { taskId: first }), signal);

  assert.match(resultOutput(got), /first/);

  const missing = await port.execute(call("g2", "task_get", { taskId: "999" }), signal);

  assert.equal(resultValue(missing)["task"], null);

  const moved = await port.execute(call("u1", "task_update", { taskId: first, status: "in_progress" }), signal);

  assert.equal(moved.outcome, "result");

  const listed = await port.execute(call("l1", "task_list"), signal);

  assert.match(resultOutput(listed), /#1/);
});

test("claims respect ownership, blockers, and single focus", async () => {
  const port = createPersistentTaskTools();
  const signal = new AbortController().signal;
  const first = await create(port, "foundation");
  const second = await create(port, "walls");

  const blocked = await port.execute(call("d1", "task_update", { taskId: second, blockedBy: first }), signal);

  assert.equal(blocked.outcome, "result");

  const early = await port.execute(call("c1", "task_update", { taskId: second, owner: "agent-a", claim: true }), signal);

  assert.equal(errorCode(early), "blocked");

  const claimed = await port.execute(call("c2", "task_update", { taskId: first, owner: "agent-a", claim: true }), signal);

  assert.equal(claimed.outcome, "result");

  const stolen = await port.execute(call("c3", "task_update", { taskId: first, owner: "agent-b", claim: true }), signal);

  assert.equal(errorCode(stolen), "already_claimed");
});

test("single focus is enforced: one open claim per agent", async () => {
  const port = createPersistentTaskTools();
  const signal = new AbortController().signal;
  const first = await create(port, "alpha");
  const second = await create(port, "beta");

  const claimed = await port.execute(call("c1", "task_update", { taskId: first, owner: "agent-1", claim: true }), signal);

  assert.equal(claimed.outcome, "result");

  const doubleClaim = await port.execute(
    call("c2", "task_update", { taskId: second, owner: "agent-1", claim: true }),
    signal,
  );

  assert.equal(errorCode(doubleClaim), "agent_busy");

  await port.execute(call("u1", "task_update", { taskId: first, status: "completed" }), signal);
  const afterFinish = await port.execute(
    call("c3", "task_update", { taskId: second, owner: "agent-1", claim: true }),
    signal,
  );

  assert.equal(afterFinish.outcome, "result");
});

test("completed is a list fact, never a quality verdict", async () => {
  const port = createPersistentTaskTools();
  const signal = new AbortController().signal;
  const id = await create(port, "ship");
  const done = await port.execute(call("u1", "task_update", { taskId: id, status: "completed" }), signal);
  const output = resultOutput(done);

  assert.match(output, /completed/);
  assert.equal(output.includes("verified"), false);
});
