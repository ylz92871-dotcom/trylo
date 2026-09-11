// Trylo Work — DiagnosticRecord tests (M3 closure spec
// §10.1/§10.2, fixing M3-P1-07 / M3-P2-03).
//
// Pins the drawer contract:
//   - every record carries routeDecision + severity —
//     dropped/replayed/late frames are never disguised
//     as normal log lines (§10.2);
//   - the ErrorCard's diagnosticId IS the drawer record
//     id, so the drawer search finds exactly one record;
//   - identity (task/run/eventType) is attached;
//   - the redacted payload never leaks full text fields;
//   - runtime-produced terminal/recover projections get
//     the same treatment.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  consumeFrame,
  FrameDedupe,
  type RuntimeUpdate,
} from "../src/consume-frame.js";
import {
  TaskRegistry,
  runIdForTask,
  type TaskRecord,
} from "../src/task-registry.js";
import { WorkRuntime } from "../src/work-runtime.js";
import type {
  ControlPlaneClient,
  EventFrame,
} from "../src/control-plane/types.js";

const TASK_ID = "task-diag-1";

function makeRecord(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    runId: runIdForTask(TASK_ID),
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

function frame(
  type: string,
  inner: Record<string, unknown>,
  seq?: number,
): EventFrame {
  return {
    type: "event",
    event: "task.event",
    payload: { taskId: TASK_ID, type, seq, payload: inner },
  };
}

function deps(record?: TaskRecord) {
  const registry = new TaskRegistry();
  registry.register(record ?? makeRecord());
  return { registry, dedupe: new FrameDedupe() };
}

describe("DiagnosticRecord: routeDecision on every path (§10.2)", () => {
  it("replay → dropped with routeDecision=replay, severity=warn", () => {
    const d = deps();
    const f = frame("timeline_step_updated", { message: "step" }, 7);
    const first = consumeFrame(f, d);
    assert.equal(first.kind, "accepted");
    const second = consumeFrame(f, d);
    assert.equal(second.kind, "dropped");
    if (second.kind !== "dropped") return;
    assert.equal(second.reason, "replay");
    assert.equal(second.diagnostic.routeDecision, "replay");
    assert.equal(second.diagnostic.severity, "warn");
    assert.equal(second.diagnostic.eventType, "timeline_step_updated");
  });

  it("late event after terminal → routeDecision=terminal_task", () => {
    const d = deps(makeRecord({ status: "completed" }));
    const update = consumeFrame(
      frame("timeline_step_updated", { message: "late" }, 9),
      d,
    );
    assert.equal(update.kind, "dropped");
    if (update.kind !== "dropped") return;
    assert.equal(update.reason, "terminal_task");
    assert.equal(update.diagnostic.routeDecision, "terminal_task");
    assert.equal(update.diagnostic.severity, "warn");
  });

  it("event for an unknown task → routeDecision=unknown_task", () => {
    const registry = new TaskRegistry();
    const update = consumeFrame(
      frame("timeline_step_updated", { message: "stranger" }, 1),
      { registry, dedupe: new FrameDedupe() },
    );
    assert.equal(update.kind, "dropped");
    if (update.kind !== "dropped") return;
    assert.equal(update.reason, "unknown_task");
    assert.equal(update.diagnostic.routeDecision, "unknown_task");
  });

  it("accepted notice → routeDecision=task_notice + run identity", () => {
    const d = deps();
    const update = consumeFrame(
      frame("timeline_step_updated", { message: "Running read_file" }, 3),
      d,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") return;
    assert.equal(update.diagnostic.routeDecision, "task_notice");
    assert.equal(update.diagnostic.severity, "info");
    assert.equal(update.diagnostic.taskId, TASK_ID);
    assert.equal(update.diagnostic.runId, runIdForTask(TASK_ID));
    assert.equal(update.diagnostic.eventType, "timeline_step_updated");
  });
});

describe("DiagnosticRecord: error correlation (§10.2, M3-P1-07)", () => {
  it("task_error remains a non-terminal recovery warning until task.get confirms failure", () => {
    const d = deps();
    const update = consumeFrame(
      frame("timeline_error", { message: "quota exceeded" }, 4),
      d,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") return;
    const item = update.items[0];
    assert.equal(item.kind, "progress");
    if (item.kind !== "progress") return;
    assert.equal(item.text, "quota exceeded");
    assert.equal(update.diagnostic.routeDecision, "task_error");
    assert.equal(update.diagnostic.severity, "warn");
    assert.equal(d.registry.get(TASK_ID)?.status, "running");
    assert.ok(update.diagnostic.normalizedError);
    assert.equal(
      update.diagnostic.normalizedError?.userMessage,
      "quota exceeded",
    );
  });
});

describe("DiagnosticRecord: redacted payload (§10.2)", () => {
  it("replaces large text fields with length markers", () => {
    const secret = "S".repeat(500);
    const d = deps();
    const update = consumeFrame(
      frame(
        "timeline_command_output",
        { command: "npm test", output: secret, type: "stdout" },
        5,
      ),
      d,
    );
    assert.equal(update.kind, "accepted");
    const red = update.diagnostic.rawPayloadRedacted;
    assert.ok(red !== undefined);
    assert.ok(!red?.includes(secret));
    assert.ok(red?.includes(`<redacted ${secret.length} chars>`));
    // Non-sensitive metadata survives redaction.
    assert.ok(red?.includes("timeline_command_output"));
    assert.ok(red?.includes("npm test"));
  });
});

// Runtime-produced records (terminal projection / recovery)
// get the same §10.1 treatment as frame-derived ones.

function clientStub(): ControlPlaneClient {
  return {
    status: () => "connected",
    connect: () => {},
    disconnect: () => {},
    send: async () => ({}),
    whenReady: async () => {},
    on: () => () => {},
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("WorkRuntime-produced DiagnosticRecords", () => {
  it("terminal failure: id=diagnosticId, routeDecision=terminal_projection", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = new WorkRuntime({
      client: clientStub(),
      tauri: { invoke: async <T,>(): Promise<T> => ({}) as T },
      events: { onRuntimeUpdate: (u) => updates.push(u) },
    });
    rt.registry.register(makeRecord());
    rt.registry.update(TASK_ID, {
      status: "failed",
      terminalError: "boom",
      updatedAt: 2000,
    });
    await flush();
    assert.equal(updates.length, 1);
    const u = updates[0];
    if (u.kind !== "accepted") throw new Error("expected accepted");
    const item = u.items[0];
    assert.equal(item.kind, "error");
    if (item.kind !== "error") return;
    assert.equal(item.diagnosticId, u.diagnostic.id);
    assert.equal(u.diagnostic.routeDecision, "terminal_projection");
    assert.equal(u.diagnostic.severity, "error");
    assert.equal(u.diagnostic.taskId, TASK_ID);
    assert.equal(u.diagnostic.runId, runIdForTask(TASK_ID));
  });
});
