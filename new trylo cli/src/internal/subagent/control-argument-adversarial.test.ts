import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";

function harness() {
  let requests = 0, sequence = 0;
  const tools = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" as const }), cancel: async () => {} };
  const runtime = new SubagentRuntime({ tools });
  const control = createSubagentControlTool({ runtime, provider: { async *stream() {
    requests++;
    yield { type: "text_start" as const, blockId: "answer" };
    yield { type: "text_delta" as const, blockId: "answer", text: "ANSWER" };
    yield { type: "text_end" as const, blockId: "answer" };
    yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
  } }, permission: {
    request: async () => { throw new Error("unexpected approval"); },
    awaitDecision: async () => { throw new Error("unexpected approval"); },
  } });
  const call = (name: string, args: JsonObject) => control.execute({ name, arguments: args,
    toolCallId: `control-${++sequence}` }, new AbortController().signal);
  const spawn = async () => {
    const result = await call("spawn_agent", { message: "Reply ANSWER" });
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") throw new Error("spawn failed");
    return String(result.value["task_id"]);
  };

  return { runtime, call, spawn, requests: () => requests };
}

for (const invalid of ["true", 1, null, { requested: true }] satisfies JsonValue[]) {
  test(`malformed fork_context ${JSON.stringify(invalid)} refuses before spawning`, async t => {
    const h = harness();
    t.after(() => h.runtime.cancelAll());
    const result = await h.call("spawn_agent", { message: "must never start", fork_context: invalid });
    assert.equal(result.outcome, "error");
    if (result.outcome === "error") assert.equal(result.code, "invalid_arguments");
    assert.equal(h.requests(), 0);
    assert.deepEqual(h.runtime.getActiveInstances(), []);
  });
}

test("a malformed force flag cannot close a live task's input channel", async t => {
  const h = harness();
  t.after(() => h.runtime.cancelAll());
  const target = await h.spawn();
  const refused = await h.call("close_agent", { target, force: "false" });
  assert.equal(refused.outcome, "error");
  if (refused.outcome === "error") assert.equal(refused.code, "invalid_arguments");
  assert.equal((await h.call("send_input", { target, message: "another valid round" })).outcome, "result");
});

test("a malformed legacy interrupt flag cannot enqueue a new instruction", async t => {
  const h = harness();
  t.after(() => h.runtime.cancelAll());
  const target = await h.spawn();

  await h.call("wait_agent", { targets: [target], timeout_ms: 1000 });
  const before = h.requests();
  const refused = await h.call("send_input", { target, message: "must not execute", interrupt: "true" });

  assert.equal(refused.outcome, "error");

  if (refused.outcome === "error") assert.equal(refused.code, "invalid_arguments");

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.requests(), before);
});

test("malformed release_on_ready is rejected without retiring a ready member", async t => {
  const h = harness();
  t.after(() => h.runtime.cancelAll());
  const target = await h.spawn();

  await h.call("wait_agent", { targets: [target], timeout_ms: 1000 });
  const refused = await h.call("wait_agent", { targets: [target], timeout_ms: 0, release_on_ready: "true" });

  assert.equal(refused.outcome, "error");

  if (refused.outcome === "error") assert.equal(refused.code, "invalid_arguments");

  assert.equal((await h.call("send_input", { target, message: "valid continuation" })).outcome, "result");
});

test("an explicit null input mode cannot silently enqueue an append instruction", async t => {
  const h = harness();
  t.after(() => h.runtime.cancelAll());
  const target = await h.spawn();
  await h.call("wait_agent", { targets: [target], timeout_ms: 1000 });
  const refused = await h.call("send_input", { target, message: "must not enqueue", mode: null });
  assert.equal(refused.outcome, "error");
  if (refused.outcome === "error") assert.equal(refused.code, "invalid_arguments");
});

for (const [field, value] of [["model", 17], ["agent_type", { name: "reviewer" }]] satisfies [string, JsonValue][]) {
  test(`malformed ${field} cannot silently fall back to the parent profile`, async t => {
    const h = harness();
    t.after(() => h.runtime.cancelAll());
    const refused = await h.call("spawn_agent", { message: "must not start", [field]: value });
    assert.equal(refused.outcome, "error");
    if (refused.outcome === "error") assert.equal(refused.code, "invalid_arguments");
    assert.equal(h.requests(), 0);
    assert.deepEqual(h.runtime.getActiveInstances(), []);
  });
}

test("an explicit null resume message cannot replay the original assignment", async t => {
  const h = harness();
  t.after(() => h.runtime.cancelAll());
  const target = await h.spawn();

  await h.call("wait_agent", { targets: [target], timeout_ms: 1000, release_on_ready: true });
  const before = h.requests();
  const refused = await h.call("resume_agent", { target, message: null });

  assert.equal(refused.outcome, "error");

  if (refused.outcome === "error") assert.equal(refused.code, "invalid_arguments");

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.requests(), before);
});
