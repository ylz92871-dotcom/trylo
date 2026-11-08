import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolOutcome } from "../ports/tools.js";
import type { SubagentRoutingPort } from "../ports/subagent-routing.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";
import type { TimerScheduler } from "./scheduler.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function harness(stalledPhase: "choose" | "dispatched") {
  let time = 0, observing = false, release!: () => void, requests = 0, sequence = 0;
  const pending = new Map<() => void, number>();
  const scheduler: TimerScheduler = (delay, fire) => {
    pending.set(fire, time + delay);
    return { cancel: () => { pending.delete(fire); } };
  };
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const observe = async (phase: string) => { if (phase === stalledPhase) {
    observing = true;
    await stalled;
  } };
  const routing: SubagentRoutingPort = {
    choose: async () => {
      await observe("choose");
      return { path: "independent", reason: "test", candidateIds: ["independent", "fork"] };
    },
    dispatched: () => observe("dispatched"), finished: async () => {},
  };
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  const control = createSubagentControlTool({ runtime, routing, scheduler,
    parentMessages: [{ role: "user", content: "canonical parent context" }],
    provider: { async *stream() {
      requests++;
      yield { type: "stream_start" as const, providerId: "test", model: "test", warnings: [] };
      yield { type: "text_start" as const, blockId: "answer" };
      yield { type: "text_delta" as const, blockId: "answer", text: "REAL_ANSWER" };
      yield { type: "text_end" as const, blockId: "answer" };
      yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
    } }, permission: {
      request: async () => { throw new Error("unexpected approval"); },
      awaitDecision: async () => { throw new Error("unexpected approval"); },
    } });
  const call = (name: string, args: JsonObject, signal = new AbortController().signal) => control.execute({
    name, arguments: args, toolCallId: `call-${++sequence}` }, signal);
  const advance = (milliseconds: number) => {
    time += milliseconds;
    for (const [fire, deadline] of [...pending]) if (deadline <= time) {
      pending.delete(fire);
      fire();
    }
  };

  return { runtime, call, release, advance, observing: () => observing, requests: () => requests, timers: () => pending.size };
}

for (const phase of ["choose", "dispatched"] as const) {
  test(`a permanently pending routing ${phase} cannot withhold dispatch or its answer`, async t => {
    const h = harness(phase);
    let spawned: ToolOutcome | undefined;
    const spawning = h.call("spawn_agent", { message: "Reply REAL_ANSWER" }).then(result => { spawned = result; });

    t.after(async () => {
      h.release();
      await spawning;
      await flush();
      await h.runtime.cancelAll();
    });
    await flush();
    assert.equal(h.observing(), true);
    h.advance(2000);
    await flush();
    await flush();
    assert.equal(spawned?.outcome, "result", "bounded routing must return the dispatch receipt");

    if (spawned?.outcome !== "result") return;

    const target = String(spawned.value["task_id"]);
    const observed = await h.call("wait_agent", { targets: [target], timeout_ms: 0 });

    assert.equal(observed.outcome, "result");
    if (observed.outcome !== "result") return;

    const row = (observed.value["results"] as JsonObject)[target] as JsonObject;

    assert.equal(row["output"], "REAL_ANSWER");
    assert.equal(row["phase"], "awaiting_input");
    const receipt = row["routing"] as JsonObject;

    assert.ok((receipt["diagnostics"] as string[]).includes(`routing_${phase === "choose" ? "choose" : "dispatch"}_failed`));
    assert.equal(h.requests(), 1, "observer failure never replays a provider request");
    await h.call("close_agent", { target });
    await flush();
    assert.deepEqual(h.runtime.getActiveInstances(), []);
    assert.equal(h.timers(), 0);
  });
}

for (const phase of ["choose"] as const) {
  test(`parent cancellation cuts a pending routing ${phase} before starting a worker`, async t => {
    const h = harness(phase), controller = new AbortController();
    let outcome: ToolOutcome | undefined;
    const spawning = h.call("spawn_agent", { message: "must not start" }, controller.signal).then(result => { outcome = result; });

    t.after(async () => {
      h.release();
      await spawning;
      await h.runtime.cancelAll();
    });
    await flush();
    assert.equal(h.observing(), true);
    controller.abort();
    await flush();
    await flush();
    assert.equal(outcome?.outcome, "cancelled");
    assert.equal(h.requests(), 0);
    assert.deepEqual(h.runtime.getActiveInstances(), []);
    assert.equal(h.timers(), 0);
  });
}
