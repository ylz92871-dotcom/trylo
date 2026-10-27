import assert from "node:assert/strict";
import { test } from "node:test";
import { createTodoTools } from "../adapters/tools/todo/index.js";
import type { ToolOutcome, ToolPort } from "../ports/tools.js";
import { SubagentRuntime } from "./runtime.js";
import type { SubagentContext, SubagentPermissions, SubagentSpawnRequest } from "./types.js";

const signal = new AbortController().signal;
const todo = (count: number) => ({ toolCallId: "todo", name: "todo_write", arguments: {
  todos: Array.from({ length: count }, (_, index) => ({ content: `item ${index}`, status: "pending" })),
} });
async function run(parent: ToolPort, local: ToolPort, worker: (context: SubagentContext) => Promise<ToolOutcome>,
  permissions: SubagentPermissions = { allowedTools: ["todo_write"] }) {
  const runtime = new SubagentRuntime({ tools: parent });
  const request: SubagentSpawnRequest<ToolOutcome> & { readonly localTools: ToolPort } = {
    name: "local-state", localTools: local, permissions,
    lineage: { parentAgentId: "parent", rootAttemptId: "local-state" }, worker,
  };
  const handle = runtime.spawn(request);
  const result = await handle.wait();
  await runtime.waitForRetirement(handle.subagentId, 1000, signal);
  assert.equal(result.status, "completed");
  return result.output;
}

test("child-local record tools leave the parent reducer untouched", async () => {
  const parent = createTodoTools();
  await parent.execute(todo(2), signal);
  const child = await run(parent, createTodoTools(), context => context.tools.execute(todo(1), context.signal));
  assert.equal(child?.outcome, "result");
  if (child?.outcome === "result") assert.equal(child.value.previousTotal, 0);
  const after = await parent.execute(todo(2), signal);
  if (after.outcome === "result") assert.equal(after.value.previousTotal, 2);
  else assert.fail("parent reducer failed");
});

test("local tools cannot bypass the frozen member constraint or tool whitelist", async () => {
  const parent = createTodoTools();
  for (const permissions of [{ allowedTools: [] }, { allowedTools: ["todo_write"],
    constrainTool: () => ({ ok: false as const, code: "member_denied", message: "held" }) }]) {
    const result = await run(parent, createTodoTools(), context => context.tools.execute(todo(1), context.signal), permissions);
    assert.equal(result?.outcome, "error");
    const untouched = await parent.execute(todo(0), signal);
    if (untouched.outcome === "result") assert.equal(untouched.value.previousTotal, 0);
    else assert.fail("parent reducer failed");
  }
});

test("a local record port cannot shadow a parent mutation binding", async () => {
  let effects = 0;
  const parent: ToolPort = { snapshot: () => [{ ...createTodoTools().snapshot()[0]!, sideEffect: "workspace_write" }],
    execute: async () => { effects += 1; return { outcome: "result", value: {}, output: "mutated", truncated: false }; },
    cancel: async () => {} };
  const result = await run(parent, createTodoTools(), context => context.tools.execute(todo(1), context.signal));
  assert.equal(result?.outcome, "error");
  assert.equal(effects, 0);
});

test("cancelling an unowned call cannot reach the shared parent tool port", async () => {
  const cancelled: string[] = [];
  const parent = { ...createTodoTools(), cancel: async (id: string) => { cancelled.push(id); } };
  await run(parent, createTodoTools(), async context => {
    await context.tools.cancel("parent-live-call");
    return context.tools.execute(todo(1), context.signal);
  });
  assert.deepEqual(cancelled, []);
});

test("an in-flight local call is cancelled through its own port", async () => {
  const cancelled: string[] = [];
  let finish!: (result: ToolOutcome) => void;
  const local: ToolPort = { ...createTodoTools(),
    execute: () => new Promise<ToolOutcome>(resolve => { finish = resolve; }),
    cancel: async id => { cancelled.push(`local:${id}`); finish({ outcome: "cancelled" }); } };
  const parent = { ...createTodoTools(), cancel: async (id: string) => { cancelled.push(`parent:${id}`); } };
  const result = await run(parent, local, async context => {
    const pending = context.tools.execute(todo(1), context.signal);
    await context.tools.cancel("todo");
    return pending;
  });
  assert.equal(result?.outcome, "cancelled");
  assert.deepEqual(cancelled, ["local:todo"]);
});
