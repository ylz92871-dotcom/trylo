import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolOutcome } from "../ports/tools.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";
import { SubagentGovernanceTracker } from "./governance.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

for (const collision of ["wait_agent", "close_agent"] as const) {
  test(`an active call id cannot be replaced by ${collision}; cancellation and later reuse stay usable`, async t => {
    const runtime = new SubagentRuntime({
      tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
      governance: new SubagentGovernanceTracker({ timeoutMs: 0 }),
    });
    const control = createSubagentControlTool({ runtime,
      provider: { async *stream(_request, signal) {
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } },
      permission: { request: async () => { throw new Error("unexpected approval"); },
        awaitDecision: async () => { throw new Error("unexpected approval"); } },
    });
    const signal = new AbortController();

    t.after(async () => {
      signal.abort();
      await runtime.cancelAll();
    });
    const spawned = await control.execute({ name: "spawn_agent", toolCallId: "spawn",
      arguments: { message: "hold" } }, signal.signal);

    assert.equal(spawned.outcome, "result");
    if (spawned.outcome !== "result") return;

    const target = spawned.value["task_id"];

    assert.equal(typeof target, "string");
    if (typeof target !== "string") return;

    let original: ToolOutcome | undefined, duplicate: ToolOutcome | undefined;
    const first = control.execute({ name: "wait_agent", toolCallId: "shared-id",
      arguments: { targets: [target], timeout_ms: 60_000 } }, signal.signal).then(value => { original = value; });

    await flush();
    const second = control.execute({ name: collision, toolCallId: "shared-id",
      arguments: collision === "wait_agent" ? { targets: [target], timeout_ms: 60_000 } : { target, force: true } },
    signal.signal).then(value => { duplicate = value; });

    await flush();
    assert.equal(duplicate?.outcome, "error", "the duplicate must refuse before replacing an observer or changing the member");

    if (duplicate?.outcome === "error") assert.equal(duplicate.code, "invalid_arguments");

    assert.equal(runtime.status(target), "running");
    await control.cancel("shared-id");
    await first;
    assert.equal(original?.outcome, "cancelled", "cancel must still address the original observation");
    await second;
    assert.equal(runtime.status(target), "running", "cancelling an observation leaves its member alive");
    const reused = await control.execute({ name: "wait_agent", toolCallId: "shared-id",
      arguments: { targets: [target], timeout_ms: 0 } }, signal.signal);

    assert.equal(reused.outcome, "result", "a settled id can be reused without retaining an unbounded history");
  });
}
