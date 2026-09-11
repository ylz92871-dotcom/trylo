// Trylo Work — TaskRegistry unit tests.
//
// v1.16.5+ (W-RUN-002, Phase B1 of the M1 lifecycle
// milestone). Covers the data structure that the
// EventRouter, Reconciler, and WorkRuntime all read from /
// write to.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TaskRegistry,
  isTerminal,
  newRunId,
  runIdForTask,
  type TaskRecord,
  type TaskStatus,
} from "../src/task-registry.js";

function makeRecord(over: Partial<TaskRecord> = {}): TaskRecord {
  const taskId = over.taskId ?? "task-1";
  return {
    taskId,
    runId: runIdForTask(taskId),
    turnId: undefined,
    workspaceId: "ws-1",
    projectRoot: "D:/repo",
    conversationId: "conv-1",
    sessionId: "conv-1",
    status: "running" as TaskStatus,
    lastSeq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    terminalError: undefined,
    ...over,
  };
}

describe("TaskRegistry: register / get / remove", () => {
  it("registers a new task and exposes it", () => {
    const r = new TaskRegistry();
    const record = makeRecord();
    r.register(record);
    assert.equal(r.get("task-1"), record);
  });

  it("rejects a different conversation binding for the same taskId", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "task-1", conversationId: "conv-A" }));
    assert.throws(
      () => r.register(makeRecord({ taskId: "task-1", conversationId: "conv-B" })),
      /already bound to conversationId=conv-A/,
    );
  });

  it("re-binding to the same conversation is an update, not a throw", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "task-1", conversationId: "conv-A" }));
    r.register(makeRecord({ taskId: "task-1", conversationId: "conv-A", status: "completed" }));
    assert.equal(r.get("task-1")?.status, "completed");
  });

  it("removes a task", () => {
    const r = new TaskRegistry();
    r.register(makeRecord());
    r.remove("task-1");
    assert.equal(r.get("task-1"), undefined);
  });

  it("remove on unknown task is a no-op", () => {
    const r = new TaskRegistry();
    r.remove("never-existed");
    assert.equal(r.get("never-existed"), undefined);
  });
});

describe("TaskRegistry: update", () => {
  it("patches only the fields provided", () => {
    const r = new TaskRegistry();
    r.register(
      makeRecord({
        status: "running",
        lastSeq: 0,
        terminalError: undefined,
      }),
    );
    r.update("task-1", { status: "completed", updatedAt: 9999 });
    const got = r.get("task-1");
    assert.ok(got);
    assert.equal(got.status, "completed");
    assert.equal(got.updatedAt, 9999);
    assert.equal(got.lastSeq, 0);
  });

  it("update on unknown task is a silent no-op", () => {
    const r = new TaskRegistry();
    r.update("never-existed", { status: "completed" });
    assert.equal(r.get("never-existed"), undefined);
  });

  it("running never regresses to pending (spec §4.3)", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "t1", status: "running" }));
    r.update("t1", { status: "pending" });
    assert.equal(r.get("t1")?.status, "running");
    r.update("t1", { status: "starting" });
    assert.equal(r.get("t1")?.status, "running");
  });

  it("paused is reversible within the same active run", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "t1", status: "running" }));
    r.update("t1", { status: "paused" });
    assert.equal(r.get("t1")?.status, "paused");
    assert.equal(r.getByConversation("conv-1")?.taskId, "t1");
    r.update("t1", { status: "running" });
    assert.equal(r.get("t1")?.status, "running");
  });

  it("terminal states never move again (spec §4.3)", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "t1", status: "completed" }));
    r.update("t1", { status: "running" });
    assert.equal(r.get("t1")?.status, "completed");
    r.update("t1", { status: "failed" });
    assert.equal(r.get("t1")?.status, "completed");
  });

  it("writing the same status twice is side-effect-free", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "t1", status: "running" }));
    const events: string[] = [];
    r.subscribe((_rec, kind) => events.push(kind));
    r.update("t1", { status: "running", lastSeq: 0, updatedAt: 1000 });
    assert.deepEqual(events, []);
  });
});

describe("TaskRegistry: active binding per conversation (M3-P0-01)", () => {
  it("a terminal old task never shadows a newer run", () => {
    const r = new TaskRegistry();
    r.register(
      makeRecord({ taskId: "old", conversationId: "conv-A", status: "running" }),
    );
    r.update("old", { status: "completed" });
    r.register(
      makeRecord({ taskId: "new", conversationId: "conv-A", status: "running" }),
    );
    const got = r.getByConversation("conv-A");
    assert.ok(got);
    assert.equal(got.taskId, "new");
  });

  it("terminal history stays retrievable via get()", () => {
    const r = new TaskRegistry();
    r.register(
      makeRecord({ taskId: "old", conversationId: "conv-A", status: "running" }),
    );
    r.update("old", { status: "completed" });
    assert.equal(r.getByConversation("conv-A"), undefined);
    assert.ok(r.get("old"));
    assert.equal(r.get("old")?.status, "completed");
  });

  it("a late terminal event from the OLD task does not clear the new binding", () => {
    const r = new TaskRegistry();
    r.register(
      makeRecord({ taskId: "old", conversationId: "conv-A", status: "running" }),
    );
    r.register(
      makeRecord({ taskId: "new", conversationId: "conv-A", status: "running" }),
    );
    // old's binding was already replaced by register(new).
    // A late terminal for old must not touch new's binding.
    r.update("old", { status: "completed" });
    assert.equal(r.getByConversation("conv-A")?.taskId, "new");
  });

  it("registering a new active task replaces the previous binding", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "a", conversationId: "conv-A" }));
    r.register(makeRecord({ taskId: "b", conversationId: "conv-A" }));
    assert.equal(r.getByConversation("conv-A")?.taskId, "b");
  });

  it("remove() clears the active binding when it points at the removed task", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "a", conversationId: "conv-A" }));
    r.remove("a");
    assert.equal(r.getByConversation("conv-A"), undefined);
  });
});

describe("runIdForTask", () => {
  it("derives a stable, repeatable run identity", () => {
    assert.equal(runIdForTask("abc"), "run:abc");
    assert.equal(runIdForTask("abc"), runIdForTask("abc"));
  });
});

describe("newRunId (M4-B: one task, many runs)", () => {
  it("produces unique ids on every call", () => {
    const a = newRunId();
    const b = newRunId();
    assert.notEqual(a, b);
    assert.ok(a.length > 0);
    assert.ok(b.length > 0);
  });
});

describe("TaskRegistry: beginFollowUp (M4-B, §6.1/§4.3)", () => {
  it("reactivates a terminal task with a NEW runId, keeping taskId", () => {
    const r = new TaskRegistry();
    const firstRun = "run:first";
    r.register(
      makeRecord({
        taskId: "task-1",
        conversationId: "conv-A",
        runId: firstRun,
        status: "running",
      }),
    );
    r.update("task-1", { status: "completed" });
    assert.equal(r.getByConversation("conv-A"), undefined); // terminal → inactive
    const secondRun = "run:second";
    const rec = r.beginFollowUp({ taskId: "task-1", runId: secondRun, turnId: "turn-2" });
    assert.equal(rec.taskId, "task-1"); // thread id durable
    assert.equal(rec.runId, secondRun); // brand-new run
    assert.notEqual(rec.runId, firstRun);
    assert.equal(rec.delivery, "follow_up");
    assert.equal(rec.status, "starting");
    assert.equal(rec.turnId, "turn-2");
    assert.equal(r.getByConversation("conv-A")?.taskId, "task-1"); // active again
  });

  it("a third follow-up keeps taskId and yields yet another runId", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "task-9", conversationId: "conv-A", status: "running" }));
    r.update("task-9", { status: "completed" });
    r.beginFollowUp({ taskId: "task-9", runId: "run:r2", turnId: "t2" });
    r.update("task-9", { status: "failed" });
    const rec = r.beginFollowUp({ taskId: "task-9", runId: "run:r3", turnId: "t3" });
    assert.equal(rec.taskId, "task-9");
    assert.equal(rec.runId, "run:r3");
    assert.equal(rec.status, "starting");
    assert.equal(rec.turnId, "t3");
  });

  it("throws for an unknown taskId", () => {
    const r = new TaskRegistry();
    assert.throws(
      () => r.beginFollowUp({ taskId: "never", runId: "run:x" }),
      /unknown taskId=never/,
    );
  });

  it("terminal exactly-once projection is scoped per run, not per task (M4-B)", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "task-1", conversationId: "conv-A", runId: "run:1", status: "running" }));
    r.update("task-1", { status: "completed" });
    // Follow-up run: a terminal → running transition is legal via beginFollowUp.
    r.beginFollowUp({ taskId: "task-1", runId: "run:2", turnId: "t2" });
    assert.equal(r.getByConversation("conv-A")?.status, "starting");
    r.update("task-1", { status: "completed" });
    assert.equal(r.getByConversation("conv-A"), undefined);
    assert.equal(r.get("task-1")?.runId, "run:2"); // the last run wins
  });
});

describe("TaskRegistry: lookups by project / conversation", () => {
  it("getByConversation finds the active task", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "t1", conversationId: "conv-X" }));
    r.register(makeRecord({ taskId: "t2", conversationId: "conv-Y" }));
    const got = r.getByConversation("conv-Y");
    assert.ok(got);
    assert.equal(got.taskId, "t2");
  });

  it("listByProject filters by project root", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "t1", projectRoot: "D:/repo-A" }));
    r.register(makeRecord({ taskId: "t2", projectRoot: "D:/repo-B" }));
    r.register(makeRecord({ taskId: "t3", projectRoot: "D:/repo-A" }));
    const aTasks = r.listByProject("D:/repo-A");
    assert.equal(aTasks.length, 2);
    const ids = aTasks.map((t) => t.taskId).sort();
    assert.deepEqual(ids, ["t1", "t3"]);
  });

  it("listNonTerminal excludes terminal states", () => {
    const r = new TaskRegistry();
    r.register(makeRecord({ taskId: "t1", projectRoot: "D:/repo", status: "running" }));
    r.register(makeRecord({ taskId: "t2", projectRoot: "D:/repo", status: "completed" }));
    r.register(makeRecord({ taskId: "t3", projectRoot: "D:/repo", status: "failed" }));
    r.register(makeRecord({ taskId: "t4", projectRoot: "D:/repo", status: "running" }));
    const nonTerminal = r.listNonTerminal("D:/repo");
    const ids = nonTerminal.map((t) => t.taskId).sort();
    assert.deepEqual(ids, ["t1", "t4"]);
  });
});

describe("TaskRegistry: subscribers", () => {
  it("fires registered / updated / deactivated / removed", () => {
    const r = new TaskRegistry();
    const events: Array<{ id: string; kind: string }> = [];
    r.subscribe((rec, kind) => events.push({ id: rec.taskId, kind }));
    r.register(makeRecord({ taskId: "t1" }));
    r.update("t1", { status: "completed" });
    r.remove("t1");
    assert.deepEqual(events, [
      { id: "t1", kind: "registered" },
      // terminal transition clears the active binding
      // first, then reports the status update
      { id: "t1", kind: "deactivated" },
      { id: "t1", kind: "updated" },
      { id: "t1", kind: "removed" },
    ]);
  });

  it("a listener that throws does not poison the data path", () => {
    const r = new TaskRegistry();
    r.subscribe(() => {
      throw new Error("boom");
    });
    const events: string[] = [];
    r.subscribe((rec, kind) => events.push(`${rec.taskId}:${kind}`));
    r.register(makeRecord({ taskId: "t1" }));
    assert.deepEqual(events, ["t1:registered"]);
  });

  it("unsubscribe stops events", () => {
    const r = new TaskRegistry();
    const events: string[] = [];
    const off = r.subscribe((rec, kind) => events.push(`${rec.taskId}:${kind}`));
    r.register(makeRecord({ taskId: "t1" }));
    off();
    r.update("t1", { status: "completed" });
    assert.deepEqual(events, ["t1:registered"]);
  });
});

describe("isTerminal", () => {
  it("matches the three terminal states", () => {
    assert.equal(isTerminal("completed"), true);
    assert.equal(isTerminal("failed"), true);
    assert.equal(isTerminal("cancelled"), true);
  });
  it("rejects non-terminal states", () => {
    assert.equal(isTerminal("running"), false);
    assert.equal(isTerminal("pending"), false);
    assert.equal(isTerminal("starting"), false);
    assert.equal(isTerminal("paused"), false);
  });
});
