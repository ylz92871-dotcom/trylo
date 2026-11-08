import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderMessage, ProviderPort, ProviderRequest } from "../ports/provider.js";
import { emptyUsage } from "../ports/provider.js";
import type { SubagentRoutingPort, SubagentRoutingDispatch, SubagentRoutingFinish } from "../ports/subagent-routing.js";
import type { JsonObject } from "../protocol/envelope.js";
import { object } from "../learning/reward/validate.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";
import { isSubagentCheckpoint, type SubagentCheckpoint } from "./checkpoint.js";

const parent: readonly ProviderMessage[] = [{ role: "user", content: "Parent-only source: answer is cobalt." }];
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(options: { parent?: readonly ProviderMessage[]; fail?: "before" | "after"; hold?: boolean;
  omitUsage?: boolean;
  answer?: string; badCheck?: boolean;
  choose?: SubagentRoutingPort["choose"]; badObserver?: boolean; checkpoints?: Map<string, SubagentCheckpoint> } = {}) {
  const requests: ProviderRequest[] = [];
  const dispatched: SubagentRoutingDispatch[] = [], finished: SubagentRoutingFinish[] = [];
  const outputs: { readonly text: string }[] = [];
  const callbackOrder: string[] = [];
  let chosen = 0, prepared = 0, ids = 0;
  const runtime = new SubagentRuntime({ idGenerator: name => `${name}-${++ids}`,
    tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  const provider: ProviderPort = { async *stream(request, signal) {
    requests.push(request);

    if (options.fail === "before") throw new Error("pre-send failure");

    yield { type: "stream_start", providerId: "fixture", model: "fixture", warnings: [] };

    if (!options.omitUsage) yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 7, outputTokens: 3, totalTokens: 10 } };

    if (options.fail === "after") throw new Error("post-send failure");

    if (options.hold) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }

    yield { type: "text_start", blockId: "text" };
    yield { type: "text_delta", blockId: "text", text: options.answer ?? "answer" };
    yield { type: "text_end", blockId: "text" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  // Legacy hosts may still attach retired hooks. The execution port must ignore them.
  const retiredHooks = {
    prepare: async () => { prepared++; },
    checkOutput: async (input: { readonly text: string }) => {
      outputs.push(input);
      callbackOrder.push("check");
      if (options.badCheck) throw new Error("checker failed");
    },
  };
  const routing: SubagentRoutingPort = {
    choose: async input => { chosen += 1;
    return options.choose?.(input) ?? {
      path: "fork", reason: "learned_policy", versionId: "context-v1", candidateIds: ["independent", "fork"] }; },
    dispatched: async input => {
      dispatched.push(input);
      if (options.badObserver) throw new Error("observer unavailable");
    },
    finished: async input => {
      finished.push(input);
      callbackOrder.push("finished");
      if (options.badObserver) throw new Error("observer unavailable");
    },
    ...retiredHooks,
  };
  const saved = options.checkpoints;
  const control = createSubagentControlTool({ runtime, provider, routing, routingNow: () => 100,
    permission: { request: async () => { throw new Error("no permission expansion"); }, awaitDecision: async () => { throw new Error("no permission expansion"); } },
    allowedTools: [], ...(options.parent === undefined ? {} : { parentMessages: options.parent }),
    ...(saved === undefined ? {} : { checkpoints: { save: async checkpoint => { saved.set(checkpoint.taskId, checkpoint); },
      read: target => {
        const checkpoint = saved.get(target);
        return checkpoint === undefined ? { kind: "missing" as const } : { kind: "ready" as const, checkpoint };
      },
      list: () => [...saved.values()].map(checkpoint => ({ kind: "ready" as const, checkpoint })) } }),
  });
  const call = async (name: string, args: JsonObject, signal = new AbortController().signal) => control.execute({ name, toolCallId: `call-${++ids}`, arguments: args }, signal);
  const spawn = async (args: JsonObject = {}) => {
    const result = await call("spawn_agent", { message: "Use the source above", ...args });
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") throw new Error("spawn failed");
    assert.equal(typeof result.value.agent_id, "string");
    return { id: String(result.value.agent_id), taskId: String(result.value.task_id), value: result.value };
  };

  return { runtime, control, requests, dispatched, finished, outputs, callbackOrder, call, spawn, chosen: () => chosen, prepared: () => prepared };
}

test("learned fork changes actual provider context and records sent version plus settled token cost", async t => {
  const h = harness({ parent });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();

  await turn();
  assert.equal(h.chosen(), 1);
  assert.ok(h.requests[0]?.messages.some(message => message.content.includes("cobalt")));
  assert.ok(object(spawned.value.routing));
  assert.equal(spawned.value.routing.versionId, "context-v1");
  assert.deepEqual(spawned.value.routing.candidateIds, ["independent", "fork"]);
  await h.call("close_agent", { target: spawned.id });
  await h.runtime.settled(spawned.id);
  await turn();
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0]?.decision.versionId, "context-v1");
  assert.equal(h.finished[0]?.actualPath, "fork");
  assert.deepEqual(h.finished[0]?.usage, { state: "reported", inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  assert.equal(h.finished[0]?.endState, "completed");
  assert.equal(h.finished[0]?.taskId, spawned.taskId);
  assert.equal(JSON.stringify([...h.dispatched, ...h.finished]).includes("cobalt"), false);
});

test("explicit false remains independent and explicit true retains the established fork", async t => {
  for (const fork_context of [false, true]) {
    const h = harness({ parent });
    t.after(() => h.runtime.cancelAll());
    const spawned = await h.spawn({ fork_context });
    await turn();
    assert.equal(h.chosen(), 0);
    assert.equal(h.requests[0]?.messages.some(message => message.content.includes("cobalt")), fork_context);
    await h.call("close_agent", { target: spawned.id });
    await h.runtime.settled(spawned.id);
  }
});

test("unavailable parent context and invalid candidates fall back without inventing a fork", async t => {
  const h = harness({ parent: [] });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();
  await turn();
  assert.ok(object(spawned.value.routing));
  assert.equal(spawned.value.routing.path, "independent");
  assert.deepEqual(spawned.value.routing.candidateIds, ["independent"]);
  await h.call("close_agent", { target: spawned.id });
  await h.runtime.settled(spawned.id);
  const invalid = harness({ parent, choose: async () => ({ path: "fork", reason: "invalid", candidateIds: ["unapproved-worker"] }) });

  t.after(() => invalid.runtime.cancelAll());
  const refused = await invalid.spawn();
  await turn();
  assert.ok(object(refused.value.routing));
  assert.equal(refused.value.routing.path, "independent");
  assert.equal(invalid.requests[0]?.messages.some(message => message.content.includes("cobalt")), false);
  await invalid.call("close_agent", { target: refused.id });
  await invalid.runtime.settled(refused.id);
});

test("failure before send records no dispatch; failure after send retains actual spent tokens", async t => {
  for (const fail of ["before", "after"] as const) {
    const h = harness({ parent, fail });
    t.after(() => h.runtime.cancelAll());
    const spawned = await h.spawn();
    await h.runtime.settled(spawned.id);
    await turn();
    assert.equal(h.dispatched.length, fail === "before" ? 0 : 1);
    assert.equal(h.finished[0]?.endState, "failed");
    assert.equal(h.finished[0]?.usage.totalTokens, fail === "before" ? 0 : 10);
  }
});

test("cancellation waits for actual provider cleanup before reporting final usage", async t => {
  const h = harness({ parent, hold: true });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();
  await turn();
  await h.call("close_agent", { target: spawned.id, force: true });
  await turn();
  assert.equal(h.finished[0]?.endState, "cancelled");
  assert.equal(h.finished[0]?.usage.totalTokens, 10);
  assert.equal(h.dispatched.length, 1);
});

test("observer errors stay visible through wait_agent without failing execution", async t => {
  const h = harness({ parent, badObserver: true });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();
  await turn();
  await h.call("close_agent", { target: spawned.id });
  await h.runtime.settled(spawned.id);
  await turn();
  const waited = await h.call("wait_agent", { targets: [spawned.id], timeout_ms: 10 });

  assert.equal(waited.outcome, "result");

  if (waited.outcome !== "result") return;

  assert.ok(object(waited.value.results));
  const row = waited.value.results[spawned.id];
  assert.ok(object(row));
  assert.ok(object(row.routing));
  assert.deepEqual(row.routing.diagnostics, ["routing_dispatch_failed", "routing_finish_failed"]);
  assert.equal(h.finished[0]?.endState, "completed");
});

test("checkpoint routing receipts reject authority and cold resume preserves context plus version", async t => {
  const saved = new Map<string, SubagentCheckpoint>();
  const h = harness({ parent, checkpoints: saved });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();
  await turn();
  await h.call("close_agent", { target: spawned.id });
  await h.runtime.settled(spawned.id);
  await turn();
  const checkpoint = saved.get(spawned.taskId);
  assert.ok(checkpoint);
  assert.equal(isSubagentCheckpoint(checkpoint), true);
  assert.equal(isSubagentCheckpoint({ ...checkpoint, routing: { ...checkpoint.routing, skipApproval: true } }), false);
  const restored = harness({ checkpoints: saved, choose: async () => { throw new Error("resume must not choose"); } });

  t.after(() => restored.runtime.cancelAll());
  const resumed = await restored.call("resume_agent", { target: spawned.taskId, message: "Continue" });

  assert.equal(resumed.outcome, "result");
  if (resumed.outcome !== "result") return;

  await turn();
  assert.equal(restored.chosen(), 0);
  assert.ok(restored.requests[0]?.messages.some(message => message.content.includes("cobalt")));
  const id = String(resumed.value.agent_id);
  await restored.call("close_agent", { target: id });
  await restored.runtime.settled(id);
  await turn();
  assert.equal(restored.finished[0]?.decision.versionId, "context-v1");
  assert.equal(restored.finished[0]?.taskId, spawned.taskId);
});

test("cancellation while choosing never spawns a child or turns into execution failure", async t => {
  const controller = new AbortController();
  const h = harness({ parent, choose: async () => {
    controller.abort();
    return { path: "fork", reason: "late", candidateIds: ["independent", "fork"] };
  } });

  t.after(() => h.runtime.cancelAll());
  const result = await h.call("spawn_agent", { message: "cancel before spawn" }, controller.signal);

  assert.equal(result.outcome, "cancelled");
  assert.equal(h.requests.length, 0);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.finished.length, 0);
});

test("follow-up rounds keep the same receipt and account each real request once", async t => {
  const h = harness({ parent });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();
  await turn();
  await h.call("send_input", { target: spawned.id, message: "Follow up" });
  await turn();
  await h.call("close_agent", { target: spawned.id });
  await h.runtime.settled(spawned.id);
  await turn();
  assert.equal(h.chosen(), 1);
  assert.equal(h.dispatched.length, 2);
  assert.equal(new Set(h.dispatched.map(item => item.requestId)).size, 2);
  assert.deepEqual(h.dispatched.map(item => item.round), [1, 2]);
  assert.equal(h.finished.length, 1);
  assert.equal(h.finished[0]?.round, 2);
  assert.equal(h.finished[0]?.usage.totalTokens, 20);
});

test("sent requests without provider usage remain unknown instead of becoming zero-cost evidence", async t => {
  const h = harness({ parent, omitUsage: true });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();
  await turn();
  await h.call("close_agent", { target: spawned.id });
  await h.runtime.settled(spawned.id);
  await turn();
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.finished[0]?.usage.state, "unknown");
  assert.equal(h.finished[0]?.usage.totalTokens, 0);
});

test("retired raw routing hooks cannot capture context or output while real execution facts remain available", async t => {
  const h = harness({ parent, answer: "private assistant output", badCheck: true });
  t.after(() => h.runtime.cancelAll());
  const spawned = await h.spawn();
  await turn();
  await h.call("close_agent", { target: spawned.id });
  await h.runtime.settled(spawned.id);
  await turn();
  assert.equal(h.prepared(), 0);
  assert.equal(h.outputs.length, 0);
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.finished[0]?.endState, "completed");
  assert.deepEqual(h.finished[0]?.usage, { state: "reported", inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  assert.deepEqual(h.callbackOrder, ["finished"]);
  assert.equal(JSON.stringify([...h.dispatched, ...h.finished]).includes("private assistant output"), false);
});
