import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TaskReconciler } from "../src/task-reconciler.js";
import { TaskRegistry } from "../src/task-registry.js";
import type { ControlPlaneClient } from "../src/control-plane/types.js";

describe("TaskReconciler lifecycle", () => {
  it("stop wakes an in-flight polling backoff immediately", async () => {
    const registry = new TaskRegistry();
    registry.register({
      taskId: "task-stop",
      conversationId: "conversation-stop",
      projectRoot: "C:/work/demo-ws",
      status: "running",
    });
    let requested = false;
    const client = {
      send: async () => {
        requested = true;
        throw new Error("temporary control-plane failure");
      },
    } as unknown as ControlPlaneClient;
    const reconciler = new TaskReconciler({
      client,
      registry,
      pollIntervalMs: 5_000,
    });

    reconciler.start();
    for (let i = 0; i < 20 && !requested; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(requested, true);

    const startedAt = Date.now();
    await reconciler.stop();
    assert.ok(Date.now() - startedAt < 250, "stop must not wait for the polling backoff");
  });

  it("does not let the previous turn's terminal row kill a starting follow-up", async () => {
    const registry = new TaskRegistry();
    registry.register({
      taskId: "task-follow-up",
      runId: "run-follow-up",
      conversationId: "conversation-follow-up",
      projectRoot: "C:/work/demo-ws",
      status: "starting",
      delivery: "follow_up",
      lastSeq: 0,
    });
    let reads = 0;
    const client = {
      send: async () => {
        reads += 1;
        return {
          task: {
            id: "task-follow-up",
            status: "completed",
            updatedAt: Date.now(),
            resultSummary: "previous turn",
          },
        };
      },
    } as unknown as ControlPlaneClient;
    const reconciler = new TaskReconciler({ client, registry, pollIntervalMs: 2 });

    reconciler.start();
    for (let i = 0; i < 50 && reads === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(reads > 0);
    assert.equal(registry.get("task-follow-up")?.status, "starting");

    // The executor's first accepted event proves the new turn is live. A
    // later terminal poll now belongs to this turn and must be applied.
    registry.update("task-follow-up", { status: "running", lastSeq: 1 });
    for (let i = 0; i < 50 && registry.get("task-follow-up")?.status !== "completed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(registry.get("task-follow-up")?.status, "completed");
    await reconciler.stop();
  });
});
