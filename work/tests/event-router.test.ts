// Trylo Work — EventRouter unit tests.
//
// v1.16.5+ (W-RUN-003, Phase B2 of the M1 lifecycle
// milestone). The router is the layer that ensures an
// event for task A does NOT land in conversation B. These
// tests cover the decision matrix end-to-end.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { routeTaskEvent, type RouterDecision } from "../src/event-router.js";
import { TaskRegistry, type TaskRecord } from "../src/task-registry.js";
import type { EventFrame } from "../src/control-plane/types.js";

function makeFrame(event: string, payload: unknown): EventFrame {
  return { type: "event", event, payload };
}

function activeRecord(over: Partial<TaskRecord> = {}): TaskRecord {
  const taskId = over.taskId ?? "task-1";
  return {
    taskId,
    runId: `run:${taskId}`,
    turnId: undefined,
    workspaceId: "ws-1",
    projectRoot: "D:/repo",
    conversationId: "conv-1",
    sessionId: "conv-1",
    status: "running",
    lastSeq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    terminalError: undefined,
    ...over,
  };
}

function taskEventFrame(
  taskId: string | undefined,
  inner: Record<string, unknown>,
): EventFrame {
  return makeFrame("task.event", taskId === undefined ? inner : { taskId, ...inner });
}

describe("EventRouter: not a task event", () => {
  it("ignores non-task.event frames", () => {
    const r = new TaskRegistry();
    r.register(activeRecord());
    const d = routeTaskEvent(makeFrame("task.created", { id: "t1" }), r);
    assert.equal(d.kind, "ignore");
  });

  it("ignores task.event with no taskId", () => {
    const r = new TaskRegistry();
    r.register(activeRecord());
    const d = routeTaskEvent(
      taskEventFrame(undefined, { type: "timeline_error" }),
      r,
    );
    assert.equal(d.kind, "ignore");
  });

  it("ignores task.event with non-object payload", () => {
    const r = new TaskRegistry();
    r.register(activeRecord());
    const d = routeTaskEvent(
      { type: "event", event: "task.event", payload: "not-an-object" } as unknown as EventFrame,
      r,
    );
    assert.equal(d.kind, "ignore");
  });
});

describe("EventRouter: taskId routing", () => {
  it("drops events for unknown taskId (cross-project isolation)", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-OTHER", { type: "timeline_step_updated", payload: { message: "hello" } }),
      r,
    );
    assert.equal(d.kind, "drop_unknown_task");
  });

  it("routes generic notice to the registered conversation", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", conversationId: "conv-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", { type: "timeline_step_updated", payload: { message: "Step 1 done" } }),
      r,
    );
    assert.equal(d.kind, "task_notice");
    if (d.kind === "task_notice") {
      assert.equal(d.conversationId, "conv-A");
      assert.equal(d.text, "Step 1 done");
      assert.equal(d.taskId, "task-A");
    }
  });

  it("maps task_paused to paused even when the outer status is absent", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", conversationId: "conv-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", {
        type: "task_paused",
        payload: { message: "Paused - awaiting user input" },
      }),
      r,
    );
    assert.equal(d.kind, "task_notice");
    if (d.kind === "task_notice") assert.equal(d.daemonStatus, "paused");
  });

  it("two tasks in different conversations: events never cross", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", conversationId: "conv-A" }));
    r.register(
      activeRecord({ taskId: "task-B", conversationId: "conv-B" }),
    );
    const dA = routeTaskEvent(
      taskEventFrame("task-A", { type: "timeline_step_updated", payload: { message: "A is working" } }),
      r,
    );
    const dB = routeTaskEvent(
      taskEventFrame("task-B", { type: "timeline_step_updated", payload: { message: "B is working" } }),
      r,
    );
    if (dA.kind !== "task_notice" || dB.kind !== "task_notice") {
      throw new Error(`expected task_notice: dA=${dA.kind} dB=${dB.kind}`);
    }
    assert.equal(dA.conversationId, "conv-A");
    assert.equal(dA.text, "A is working");
    assert.equal(dB.conversationId, "conv-B");
    assert.equal(dB.text, "B is working");
  });
});

describe("EventRouter: terminal task drop", () => {
  it("drops events for a task already marked terminal", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", status: "completed" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", { type: "timeline_step_updated", payload: { message: "late" } }),
      r,
    );
    assert.equal(d.kind, "drop_terminal_task");
  });
});

describe("EventRouter: error events", () => {
  it("routes a timeline_error to the right conversation with normalised message", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", conversationId: "conv-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", {
        type: "timeline_error",
        payload: { message: "Completion blocked" },
      }),
      r,
    );
    assert.equal(d.kind, "task_error");
    if (d.kind === "task_error") {
      assert.equal(d.conversationId, "conv-A");
      assert.equal(d.userMessage, "Completion blocked");
      assert.match(d.diagnosticId, /^err-/);
    }
  });

  it("routes an 'error' event with error.message to the right conversation", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", conversationId: "conv-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", {
        type: "error",
        error: { message: "Daemon connection lost" },
      }),
      r,
    );
    assert.equal(d.kind, "task_error");
    if (d.kind === "task_error") {
      assert.equal(d.userMessage, "Daemon connection lost");
    }
  });
});

describe("EventRouter: provider recovery visibility", () => {
  it("routes persisted llm_retry timeline updates even without a message", () => {
    const r = new TaskRegistry();
    r.register(activeRecord());
    const d = routeTaskEvent(
      taskEventFrame("task-1", {
        type: "timeline_step_updated",
        payload: { legacyType: "llm_retry", attempt: 2, maxRetries: 6 },
      }),
      r,
    );
    assert.equal(d.kind, "task_notice");
    if (d.kind === "task_notice") assert.match(d.text, /重试/);
  });

  for (const legacyType of ["llm_slow", "llm_plan_fallback"] as const) {
    it(`routes ${legacyType} without requiring a message`, () => {
      const r = new TaskRegistry();
      r.register(activeRecord());
      const d = routeTaskEvent(
        taskEventFrame("task-1", {
          type: "timeline_step_updated",
          payload: { legacyType },
        }),
        r,
      );
      assert.equal(d.kind, "task_notice");
    });
  }
});

describe("EventRouter: terminal hints", () => {
  it("emits task_terminal_hint on execution_run_summary (renderer treats as hint)", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", conversationId: "conv-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", { type: "execution_run_summary" }),
      r,
    );
    assert.equal(d.kind, "task_terminal_hint");
    if (d.kind === "task_terminal_hint") {
      assert.equal(d.status, "completed");
    }
  });

  it("emits task_terminal_hint for task_cancelled", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A", conversationId: "conv-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", { type: "task_cancelled" }),
      r,
    );
    assert.equal(d.kind, "task_terminal_hint");
    if (d.kind === "task_terminal_hint") {
      assert.equal(d.status, "cancelled");
    }
  });
});

describe("EventRouter: ignore empty / non-string messages", () => {
  it("ignores events whose nested message is empty", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", { type: "timeline_step_updated", payload: { message: "   " } }),
      r,
    );
    assert.equal(d.kind, "ignore");
  });

  it("ignores events whose nested message is missing", () => {
    const r = new TaskRegistry();
    r.register(activeRecord({ taskId: "task-A" }));
    const d = routeTaskEvent(
      taskEventFrame("task-A", { type: "timeline_step_updated", payload: {} }),
      r,
    );
    assert.equal(d.kind, "ignore");
  });
});

// Reachable from the RouterDecision type-only import to
// silence "noUnusedLocals" if any future test file folds
// these checks in.
const _decisionShape: RouterDecision | undefined = undefined;
assert(_decisionShape === undefined);
