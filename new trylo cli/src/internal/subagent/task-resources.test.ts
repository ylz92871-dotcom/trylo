import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolOutcome, ToolPort } from "../ports/tools.js";
import type { ProviderPort } from "../ports/provider.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";
import { SubagentGovernanceTracker } from "./governance.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function harness(stop: (taskId: string) => Promise<void>) {
  let requests = 0;
  const tools: ToolPort = { snapshot: () => [], cancel: async () => {},
    execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }) };
  const provider: ProviderPort = { async *stream() {
    requests += 1;
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "round ready" };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ tools, governance: new SubagentGovernanceTracker({ timeoutMs: 0 }) });
  const options = { runtime, provider, model: "test", taskResources: { stop },
    permission: { request: async () => { throw new Error("unexpected approval"); },
      awaitDecision: async () => { throw new Error("unexpected approval"); } } };
  const control = createSubagentControlTool(options);
  let sequence = 0;
  const call = (name: string, args: JsonObject) => control.execute({ name, arguments: args,
    toolCallId: `parent-${++sequence}` }, new AbortController().signal);
  return { runtime, call, requests: () => requests };
}
function value(result: ToolOutcome): JsonObject {
  assert.equal(result.outcome, "result");
  return result.outcome === "result" ? result.value : {};
}

test("force close waits for owned resources and coalesces duplicate close requests", async t => {
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const owners: string[] = [];
  const h = harness(async taskId => { owners.push(taskId); await stopped; });
  t.after(async () => { release(); await h.runtime.cancelAll(); });
  const taskId = String(value(await h.call("spawn_agent", { message: "start" }))["task_id"]);
  await h.call("wait_agent", { targets: [taskId], timeout_ms: 1000 });
  let answered = false;
  const first = h.call("close_agent", { target: taskId, force: true }).then(result => { answered = true; return result; });
  const second = h.call("close_agent", { target: taskId, force: true });
  await flush();
  assert.deepEqual(owners, [taskId]);
  assert.equal(answered, false, "closed=true requires a resource stop receipt");
  const early = await h.call("resume_agent", { target: taskId });
  assert.equal(early.outcome === "error" ? early.code : "", "agent_cleanup_pending");
  release();
  assert.equal(value(await first)["closed"], true);
  assert.equal(value(await second)["closed"], true);
});

test("a resource stop failure refuses close and recovery until an explicit stop retry succeeds", async t => {
  let refused = true;
  let stops = 0;
  const h = harness(async () => { stops += 1; if (refused) throw new Error("native termination refused"); });
  t.after(async () => { await h.runtime.cancelAll(); });
  const taskId = String(value(await h.call("spawn_agent", { message: "start" }))["task_id"]);
  await h.call("wait_agent", { targets: [taskId], timeout_ms: 1000 });
  const closed = await h.call("close_agent", { target: taskId, force: true });
  assert.equal(closed.outcome === "error" ? closed.code : "", "agent_cleanup_failed");
  const before = h.requests();
  const recovered = await h.call("resume_agent", { target: taskId });
  assert.equal(recovered.outcome === "error" ? recovered.code : "", "agent_cleanup_failed");
  assert.equal(h.requests(), before, "an unconfirmed old command cannot overlap a replacement");
  refused = false;
  assert.equal(value(await h.call("close_agent", { target: taskId, force: true }))["closed"], true);
  assert.equal(stops, 2);
  assert.equal((await h.call("resume_agent", { target: taskId })).outcome, "result");
});

test("restart stops previous task resources before a replacement provider request", async t => {
  let release!: () => void;
  const stop = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  const h = harness(async () => { stops += 1; await stop; });
  t.after(async () => { release(); await h.runtime.cancelAll(); });
  const taskId = String(value(await h.call("spawn_agent", { message: "first" }))["task_id"]);
  await h.call("wait_agent", { targets: [taskId], timeout_ms: 1000 });
  const replacement = h.call("send_input", { target: taskId, message: "replacement", mode: "restart" });
  await flush();
  assert.equal(stops, 1);
  assert.equal(h.requests(), 1);
  release();
  assert.equal(value(await replacement)["task_id"], taskId);
  await flush();
  assert.equal(h.requests(), 2);
});

test("parking and automatic continuation retain the same task resources", async t => {
  let stops = 0;
  const h = harness(async () => { stops += 1; });
  t.after(async () => { await h.runtime.cancelAll(); });
  const taskId = String(value(await h.call("spawn_agent", { message: "first" }))["task_id"]);
  await h.call("wait_agent", { targets: [taskId], timeout_ms: 1000, release_on_ready: true });
  assert.equal(stops, 0);
  assert.equal(value(await h.call("send_input", { target: taskId, message: "continue" }))["task_id"], taskId);
  assert.equal(stops, 0);
});

test("history pressure cannot evict a task whose native stop still needs retry", async t => {
  let refused = true;
  const h = harness(async () => { if (refused) throw new Error("native stop refused"); });
  t.after(async () => { await h.runtime.cancelAll(); });
  const held = String(value(await h.call("spawn_agent", { message: "retained" }))["task_id"]);
  await h.call("wait_agent", { targets: [held], timeout_ms: 1000 });
  assert.equal((await h.call("close_agent", { target: held, force: true })).outcome, "error");
  for (let index = 0; index < 70; index += 1) {
    const task = String(value(await h.call("spawn_agent", { message: `ordinary-${index}` }))["task_id"]);
    await h.call("wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
  }
  const blocked = await h.call("resume_agent", { target: held });
  assert.equal(blocked.outcome === "error" ? blocked.code : "", "agent_cleanup_failed");
  refused = false;
  assert.equal(value(await h.call("close_agent", { target: held, force: true }))["closed"], true);
});

test("many executions of a held task cannot evict unrelated recent task results", async t => {
  const h = harness(async () => { throw new Error("native stop refused"); });
  t.after(async () => { await h.runtime.cancelAll(); });
  const held = String(value(await h.call("spawn_agent", { message: "retained" }))["task_id"]);
  await h.call("wait_agent", { targets: [held], timeout_ms: 1000, release_on_ready: true });
  for (let round = 0; round < 70; round += 1) {
    value(await h.call("send_input", { target: held, message: "continue" }));
    value(await h.call("wait_agent", { targets: [held], timeout_ms: 1000, release_on_ready: true }));
  }
  const closed = await h.call("close_agent", { target: held, force: true });
  assert.equal(closed.outcome === "error" ? closed.code : "", "agent_cleanup_failed");
  const recent = String(value(await h.call("spawn_agent", { message: "independent recent task" }))["task_id"]);
  value(await h.call("wait_agent", { targets: [recent], timeout_ms: 1000, release_on_ready: true }));
  const collected = await h.call("wait_agent", { targets: [recent], timeout_ms: 0 });
  assert.equal(collected.outcome, "result", "only the latest failed cleanup entry needs retention");
});
