import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";

function harness(hold = false) {
  const callbacks: string[] = [];
  let requests = 0, entered!: () => void, sequence = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const runtime = new SubagentRuntime({ tools: {
    snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {},
  } });
  const legacyPort = {
    choose: async () => {
      callbacks.push("choose");
      return { path: "independent" as const, reason: "test", candidateIds: ["independent", "fork"] };
    },
    prepare: async () => { callbacks.push("prepare"); }, dispatched: async () => {}, finished: async () => {},
  };
  const control = createSubagentControlTool({ runtime,
    parentMessages: [{ role: "user", content: "parent input must not be collected for rejected dispatch" }],
    routing: legacyPort,
    provider: { async *stream(_request, signal) {
      requests++;
      entered();
      if (hold) {
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        return;
      }
      yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
    } },
    permission: { request: async () => { throw new Error("no approval"); }, awaitDecision: async () => { throw new Error("no approval"); } },
  });
  const call = (args: JsonObject) => control.execute({ name: "spawn_agent", toolCallId: `spawn-${++sequence}`,
    arguments: { message: "inspect", ...args } }, new AbortController().signal);

  return { runtime, callbacks, call, started, requests: () => requests };
}

for (const [name, args, code] of [
  ["malformed governance", { token_budget: "5000" }, "invalid_arguments"],
  ["malformed dependencies", { depends_on: [null] }, "invalid_arguments"],
  ["unknown dependency", { depends_on: ["missing-task"] }, "agent_dependency_unknown"],
] satisfies [string, JsonObject, string][]) {
  test(`${name} refuses before optional routing can read or record parent context`, async t => {
    const h = harness();
    t.after(() => h.runtime.cancelAll());
    const refused = await h.call(args);
    assert.equal(refused.outcome, "error");
    if (refused.outcome === "error") assert.equal(refused.code, code);
    assert.deepEqual(h.callbacks, []);
    assert.equal(h.requests(), 0);
  });
}

test("a pending dependency cannot trigger context selection before admission", async t => {
  const h = harness(true);
  t.after(() => h.runtime.cancelAll());
  const first = await h.call({});

  assert.equal(first.outcome, "result");
  if (first.outcome !== "result") return;

  await h.started;
  h.callbacks.length = 0;
  const refused = await h.call({ depends_on: [first.value["task_id"] ?? ""] });

  assert.equal(refused.outcome, "error");

  if (refused.outcome === "error") assert.equal(refused.code, "agent_dependency_pending");

  assert.deepEqual(h.callbacks, []);
  assert.equal(h.requests(), 1);
});
