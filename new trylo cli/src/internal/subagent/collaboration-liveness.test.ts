import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "../ports/provider.js";
import { emptyUsage } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createSubagentControlTool } from "./control-tools.js";
import type { SubagentCollaborationPort } from "./collaboration.js";
import { SubagentRuntime } from "./runtime.js";
import type { TimerScheduler } from "./scheduler.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

for (const phase of ["prepare", "dispatched", "accountUsage", "completed"] as const) {
  test(`a stalled collaboration ${phase} observer cannot withhold the real round answer`, async t => {
    let time = 0, observing = false, release!: () => void;
    const pending = new Map<() => void, number>();
    const scheduler: TimerScheduler = (delay, fire) => {
      pending.set(fire, time + delay);
      return { cancel: () => { pending.delete(fire); } };
    };
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const observe = async (name: string): Promise<void> => { if (name === phase) {
      observing = true;
      await stalled;
    } };
    const diagnostics: string[] = [];
    const collaboration: SubagentCollaborationPort = {
      prepare: async () => {
        await observe("prepare");
        return undefined;
      },
      dispatched: () => observe("dispatched"), accountUsage: () => observe("accountUsage"),
      completed: () => observe("completed"), ended: async () => {},
    };
    const provider: ProviderPort = { async *stream() {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "actual completed answer" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "usage", usage: emptyUsage() };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };
    const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });

    t.after(async () => {
      release();
      await flush();
      await runtime.cancelAll();
    });
    const control = createSubagentControlTool({ runtime, provider, collaboration, scheduler,
      onCollaborationFailure: failed => { diagnostics.push(failed); },
      permission: { request: async () => { throw Error("no approval"); }, awaitDecision: async () => { throw Error("no approval"); } },
      team: { runId: "liveness", members: [{ memberId: "architect", baseRole: "architect", displayName: "architect",
        role: { name: "architect", description: "inspect" } }] } });
    const call = (name: string, args: JsonObject) => control.execute({ name, arguments: args, toolCallId: name }, new AbortController().signal);
    const spawned = await call("spawn_agent", { member_id: "architect", agent_type: "architect", message: "inspect" });

    assert.equal(spawned.outcome, "result");
    if (spawned.outcome !== "result") return;

    const id = String(spawned.value["task_id"]);

    await flush();
    assert.equal(observing, true);
    time = 2000;

    for (const [fire, deadline] of [...pending]) if (deadline <= time) {
      pending.delete(fire);
      fire();
    }

    await flush();
    await flush();
    const answer = await call("wait_agent", { targets: [id], timeout_ms: 0 });

    assert.equal(answer.outcome, "result");
    if (answer.outcome !== "result") return;

    const row = (answer.value["results"] as JsonObject)[id] as JsonObject;

    assert.equal(row["output"], "actual completed answer");
    assert.equal(row["phase"], "awaiting_input");
    assert.deepEqual(diagnostics, [phase]);
    await call("close_agent", { target: id });
    await flush();
    assert.deepEqual(runtime.getActiveInstances(), [], "observer work must not retain a retired worker slot");
    assert.equal(pending.size, 0, "completed observation deadlines must be detached");
    release();
    await flush();
    assert.deepEqual(diagnostics, [phase], "late observer completion cannot replay the failure");
  });
}
