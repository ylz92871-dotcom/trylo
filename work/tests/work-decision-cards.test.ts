// Trylo Work — M4-E decision-card tests.
//
// approval / input_request (spec §6.7 Core "approval /
// input"): the daemon pauses a task awaiting a user
// decision. Trylo must (a) route the bridged events through
// the router, (b) present them as inline decision cards
// whose id is stable per approvalId / requestId so the
// granted/denied and resolved/dismissed follow-ups UPDATE
// the same card, and (c) never mis-classify them as errors.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { presentTaskEvent } from "../src/event-presenter.js";
import { routeTaskEvent } from "../src/event-router.js";
import { consumeFrame, FrameDedupe } from "../src/consume-frame.js";
import { TaskRegistry, runIdForTask } from "../src/task-registry.js";
import type { EventFrame } from "../src/control-plane/types.js";

function taskEvent(inner: Record<string, unknown>): EventFrame {
  return { type: "event", event: "task.event", payload: inner };
}

function approvalRequestedFrame(over: Record<string, unknown> = {}): EventFrame {
  return taskEvent({
    taskId: "t1",
    type: "approval_requested",
    payload: {
      approval: {
        id: "ap-1",
        taskId: "t1",
        type: "run_command",
        description: "Run shell command: git push",
        details: {},
        status: "pending",
        requestedAt: 1000,
        ...over,
      },
    },
  });
}

function inputRequestCreatedFrame(over: Record<string, unknown> = {}): EventFrame {
  return taskEvent({
    taskId: "t1",
    type: "input_request_created",
    payload: {
      request: {
        id: "ir-1",
        taskId: "t1",
        questions: [
          {
            id: "outcome",
            header: "Outcome",
            question: "What should the task deliver?",
            options: [
              { label: "Report", description: "Written report" },
              { label: "No file", description: "Answer only" },
            ],
          },
        ],
        status: "pending",
        requestedAt: 1000,
        ...over,
      },
    },
  });
}

function registeredRegistry(): TaskRegistry {
  const reg = new TaskRegistry();
  reg.register({
    taskId: "t1",
    runId: runIdForTask("t1"),
    turnId: "user-1",
    workspaceId: "ws-1",
    projectRoot: "D:/repo",
    conversationId: "conv-1",
    sessionId: "conv-1",
    status: "running",
    lastSeq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    terminalError: undefined,
  });
  return reg;
}

describe("M4-E presenter: approval cards", () => {
  it("approval_requested → pending approval card with type + description", () => {
    const out = presentTaskEvent(approvalRequestedFrame(), "t1", "run:t1");
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "approval");
    if (out.kind === "approval") {
      assert.equal(out.approvalId, "ap-1");
      assert.equal(out.type, "run_command");
      assert.equal(out.description, "Run shell command: git push");
      assert.equal(out.status, "pending");
      assert.equal(out.id, `approval:run:t1:ap-1`);
    }
  });

  it("approval_requested with an already-approved record → approved", () => {
    const out = presentTaskEvent(
      approvalRequestedFrame({ status: "approved" }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out?.kind === "approval") assert.equal(out.status, "approved");
  });

  it("approval_granted → SAME id, status approved", () => {
    const granted = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "approval_granted",
        payload: { approvalId: "ap-1", autoApproved: true },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(granted !== null);
    if (granted === null) throw new Error("unreachable");
    assert.equal(granted.kind, "approval");
    if (granted.kind === "approval") {
      assert.equal(granted.id, `approval:run:t1:ap-1`);
      assert.equal(granted.status, "approved");
    }
  });

  it("approval_denied → SAME id, status denied", () => {
    const denied = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "approval_denied",
        payload: { approvalId: "ap-1", reason: "timeout" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(denied !== null);
    if (denied?.kind === "approval") {
      assert.equal(denied.id, `approval:run:t1:ap-1`);
      assert.equal(denied.status, "denied");
    }
  });
});

describe("M4-E presenter: input-request cards", () => {
  it("input_request_created → pending input_request card with questions", () => {
    const out = presentTaskEvent(inputRequestCreatedFrame(), "t1", "run:t1");
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "input_request");
    if (out.kind === "input_request") {
      assert.equal(out.requestId, "ir-1");
      assert.equal(out.status, "pending");
      assert.equal(out.id, `input_request:run:t1:ir-1`);
      assert.equal(out.questions.length, 1);
      assert.equal(out.questions[0]?.id, "outcome");
      assert.equal(out.questions[0]?.options.length, 2);
    }
  });

  it("input_request_resolved → SAME id, status submitted with answers", () => {
    const resolved = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "input_request_resolved",
        payload: {
          requestId: "ir-1",
          status: "submitted",
          answers: { outcome: { optionLabel: "Report" } },
        },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(resolved !== null);
    if (resolved?.kind === "input_request") {
      assert.equal(resolved.id, `input_request:run:t1:ir-1`);
      assert.equal(resolved.status, "submitted");
      assert.deepEqual(resolved.answers, { outcome: { optionLabel: "Report" } });
    }
  });

  it("input_request_dismissed → SAME id, status dismissed", () => {
    const dismissed = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "input_request_dismissed",
        payload: { requestId: "ir-1", status: "dismissed" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(dismissed !== null);
    if (dismissed?.kind === "input_request") {
      assert.equal(dismissed.status, "dismissed");
    }
  });
});

describe("M4-E router: decision events pass through", () => {
  it("approval_requested → task_notice (not dropped)", () => {
    const d = routeTaskEvent(approvalRequestedFrame(), registeredRegistry());
    assert.equal(d.kind, "task_notice");
  });

  it("input_request_created → task_notice", () => {
    const d = routeTaskEvent(inputRequestCreatedFrame(), registeredRegistry());
    assert.equal(d.kind, "task_notice");
  });

  it("approval/input events are NOT classified as errors", () => {
    // isErrorEvent (and the router's error branch) must not
    // turn a user-decision pause into a task failure.
    for (const frame of [
      approvalRequestedFrame(),
      taskEvent({
        taskId: "t1",
        type: "approval_granted",
        payload: { approvalId: "ap-1" },
      }),
      taskEvent({
        taskId: "t1",
        type: "approval_denied",
        payload: { approvalId: "ap-1", reason: "timeout" },
      }),
      inputRequestCreatedFrame(),
    ]) {
      const d = routeTaskEvent(frame, registeredRegistry());
      assert.notEqual(d.kind, "task_error", frame.payload?.type as string);
    }
  });
});

describe("M4-E consumeFrame integration", () => {
  it("approval_requested produces an accepted approval item", () => {
    const reg = registeredRegistry();
    const update = consumeFrame(approvalRequestedFrame({ seq: 5 }), {
      registry: reg,
      dedupe: new FrameDedupe(),
    });
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") return;
    assert.equal(update.items.length, 1);
    assert.equal(update.items[0]?.kind, "approval");
    if (update.items[0]?.kind === "approval") {
      assert.equal(update.items[0].approvalId, "ap-1");
      assert.equal(update.items[0].status, "pending");
    }
  });

  it("approval cards keep ONE stable id across requested → granted", () => {
    const reg = registeredRegistry();
    const dedupe = new FrameDedupe();
    const first = consumeFrame(approvalRequestedFrame({ seq: 1 }), {
      registry: reg,
      dedupe,
    });
    const second = consumeFrame(
      taskEvent({
        taskId: "t1",
        type: "approval_granted",
        payload: { approvalId: "ap-1", seq: 2 },
      }),
      { registry: reg, dedupe },
    );
    assert.equal(first.kind, "accepted");
    assert.equal(second.kind, "accepted");
    if (first.kind !== "accepted" || second.kind !== "accepted") return;
    assert.equal(first.items[0]?.kind, "approval");
    assert.equal(second.items[0]?.kind, "approval");
    if (first.items[0]?.kind === "approval" && second.items[0]?.kind === "approval") {
      assert.equal(second.items[0].id, first.items[0].id);
      assert.equal(second.items[0].status, "approved");
    }
  });
});
