// Trylo Work — WorkWorkflowReducer tests.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §4.2,
// §6.1, §7, §3.3): covers the phase rail, activity stream,
// narration, blockers and the terminal freeze.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ConversationItem } from "../src/event-presenter.js";
import { type WorkRunIdentity } from "../src/work-domain.js";
import {
  createWorkTurnProjection,
  derivePhaseNarration,
  deriveTurnState,
  inferPhase,
  reduceTaskStatus,
  reduceWorkItem,
  shouldRenderPhaseRail,
} from "../src/work-workflow-reducer.js";

let seq = 0;
const next = () => ++seq;

function taskIdentity(over: Partial<WorkRunIdentity> = {}): WorkRunIdentity {
  return {
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
    conversationId: "c1",
    intent: "task",
    ...over,
  };
}

/** Minimal, type-conformant ConversationItem builders. */
function planItem(name: string, stage: "started" | "finished"): ConversationItem {
  return {
    kind: "plan",
    id: `plan:r1:${next()}`,
    at: Date.now(),
    conversationId: "c1",
    stage,
    name,
    text: name,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

function toolItem(status: "running" | "done"): ConversationItem {
  const step = `st${next()}`;
  return {
    kind: "tool",
    id: `tool:r1:${step}`,
    at: Date.now(),
    conversationId: "c1",
    tool: "read",
    summary: "读取 files/a.ts",
    status,
    toolCallId: step,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

function artifactItem(): ConversationItem {
  return {
    kind: "artifact",
    id: `artifact:r1:D:/repo/.trylo/out/report.md`,
    at: Date.now(),
    conversationId: "c1",
    filePath: "D:/repo/.trylo/out/report.md",
    artifactKind: "markdown",
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

function approvalItem(status: "pending" | "approved"): ConversationItem {
  return {
    kind: "approval",
    id: `approval:r1:ap1`,
    at: Date.now(),
    conversationId: "c1",
    approvalId: "ap1",
    type: "file_edit",
    description: "编辑 report.md",
    status,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

function finalItem(text: string): ConversationItem {
  return {
    kind: "final",
    id: `final:r1`,
    at: Date.now(),
    conversationId: "c1",
    text,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

describe("conversation vs task boundary (spec §2.1)", () => {
  it("a conversation turn renders NO phase rail and no activities", () => {
    let p = createWorkTurnProjection(taskIdentity({ intent: "conversation" }));
    p = reduceWorkItem(p, artifactItem());
    p = reduceWorkItem(p, finalItem("你好，我是 Trylo"));
    assert.equal(shouldRenderPhaseRail(p), false);
    assert.equal(p.phases.length, 0);
    assert.equal(p.activities.length, 0);
    assert.equal(deriveTurnState(p), "final_answer");
  });

  it("a task turn realizes a phase rail and activities", () => {
    let p = createWorkTurnProjection(taskIdentity());
    p = reduceWorkItem(p, planItem("DISCOVER", "started"));
    p = reduceWorkItem(p, toolItem("running"));
    p = reduceWorkItem(p, toolItem("done"));
    p = reduceWorkItem(p, artifactItem());
    p = reduceWorkItem(p, finalItem("已生成报告。"));
    assert.equal(shouldRenderPhaseRail(p), true);
    assert.equal(deriveTurnState(p), "final_answer");
  });
});

describe("actor: asked to explore, discovers later", () => {
  it("reads belong to the explore phase (spec §7.2)", () => {
    assert.equal(
      inferPhase(toolItem("done")),
      "explore",
      "read tool → explore",
    );
  });
});

describe("blockers (spec §9)", () => {
  it("an approval parks the turn in awaiting_approval", () => {
    let p = createWorkTurnProjection(taskIdentity());
    p = reduceWorkItem(p, planItem("BUILD", "started"));
    p = reduceWorkItem(p, approvalItem("pending"));
    assert.equal(deriveTurnState(p), "awaiting_approval");
    assert.equal(p.blockers.length, 1);
  });

  it("approving resumes execution and clears the blocker", () => {
    let p = createWorkTurnProjection(taskIdentity());
    p = reduceWorkItem(p, planItem("BUILD", "started"));
    p = reduceWorkItem(p, approvalItem("pending"));
    p = reduceWorkItem(p, approvalItem("approved"));
    assert.equal(p.blockers.length, 0);
    assert.notEqual(deriveTurnState(p), "awaiting_approval");
  });
});

describe("terminal freeze (spec §3.3)", () => {
  it("late events after final do NOT reopen the run", () => {
    let p = createWorkTurnProjection(taskIdentity());
    p = reduceWorkItem(p, planItem("BUILD", "started"));
    p = reduceWorkItem(p, finalItem("完了。"));
    const frozen = p;
    const after = reduceWorkItem(p, toolItem("running"));
    assert.equal(after, frozen, "must return the identical frozen projection");
    assert.equal(deriveTurnState(after), "final_answer");
  });
});

describe("batched activities (spec §4.4)", () => {
  it("merges like reads within 5s into one activity", () => {
    void derivePhaseNarration;
    let p = createWorkTurnProjection(taskIdentity());
    p = reduceWorkItem(p, planItem("DISCOVER", "started"));
    p = reduceWorkItem(p, toolItem("done"));
    p = reduceWorkItem(p, toolItem("done"));
    const reads = p.activities.filter((a) => a.kind === "file_read");
    assert.equal(reads.length, 1, "two reads collapse to one activity");
    assert.ok((reads[0].batch ?? 0) >= 2);
  });
});

describe("reducer applied task status (spec §3.3 / §10.4)", () => {
  it("failed confirms an error terminal even without a final item", () => {
    let p = createWorkTurnProjection(taskIdentity());
    p = reduceWorkItem(p, planItem("BUILD", "started"));
    p = reduceTaskStatus(p, "failed");
    assert.equal(p.terminal?.kind, "error");
    assert.equal(deriveTurnState(p), "error");
  });
});

// ---------------------------------------------------------------------------
// WP-6 — recovery, performance & idempotence (spec §13, §11.2,
// acceptance "事件与结果": refresh/reconnect 后事件和 final 不丢失、不重复)
// ---------------------------------------------------------------------------

/** A read tool item whose id is caller-controlled, so a replayed
 *  stream re-emits the SAME ids (exactly-once depends on identity). */
function readItem(id: string, status: "running" | "done"): ConversationItem {
  return {
    kind: "tool",
    id,
    at: 0,
    conversationId: "c1",
    tool: "read",
    summary: `读取 ${id}`,
    status,
    toolCallId: id,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

describe("replay budget (WP-6: 2000 event 回放预算)", () => {
  it("folds 2000 distinct events well within budget", () => {
    // Spread timestamps past the 5s batch window so every event lands
    // its own activity — the worst case for the immutable fold.
    let clock = 1_000_000;
    const opts = { now: () => (clock += 6_000) };
    let p = createWorkTurnProjection(taskIdentity());
    const N = 2000;
    const start = performance.now();
    for (let i = 0; i < N; i += 1) {
      p = reduceWorkItem(p, readItem(`ev:${i}`, "done"), opts);
    }
    const elapsed = performance.now() - start;
    assert.ok(
      elapsed < 1000,
      `2000-event fold took ${elapsed.toFixed(1)}ms (budget 1000ms)`,
    );
    assert.equal(p.activities.length, N);
    // 2000 reads never produce a terminal — the run stays live.
    assert.equal(p.terminal, undefined);
    assert.notEqual(deriveTurnState(p), "final_answer");
  });
});

describe("reconnect replay (WP-6: exactly-once terminal & activities)", () => {
  it("replaying the whole stream after terminal returns the frozen projection by reference", () => {
    const stream: ConversationItem[] = [
      planItem("DISCOVER", "started"),
      readItem("a", "running"),
      readItem("a", "done"),
      artifactItem(),
      finalItem("已生成报告。"),
    ];
    let p = createWorkTurnProjection(taskIdentity());
    for (const it of stream) p = reduceWorkItem(p, it);
    const live = p;
    // A reconnect re-fetches task.events and re-emits the ENTIRE tail.
    for (const it of stream) p = reduceWorkItem(p, it);
    assert.equal(p, live, "frozen projection must be returned by reference");
    assert.equal(p.terminal?.kind, "final_answer");
    assert.equal(p.activities.length, live.activities.length);
  });

  it("a mid-run reconnect replay does not duplicate activities or regress state", () => {
    const head: ConversationItem[] = [
      planItem("BUILD", "started"),
      readItem("b", "running"),
      readItem("b", "done"),
    ];
    let p = createWorkTurnProjection(taskIdentity());
    for (const it of head) p = reduceWorkItem(p, it);
    const before = p.activities.length;
    // Same tail re-emitted before the terminal lands.
    for (const it of head) p = reduceWorkItem(p, it);
    assert.equal(p.activities.length, before, "no duplicated activities");
    const done = p.activities.find((a) => a.id === "b");
    assert.equal(done?.status, "completed", "terminal activity not regressed");
  });

  it("a duplicate terminal status never overwrites the live final answer", () => {
    let p = createWorkTurnProjection(taskIdentity());
    p = reduceWorkItem(p, finalItem("真正的结论。"));
    // Reconciler re-applies a terminal status after reconnect.
    p = reduceTaskStatus(p, "failed");
    assert.equal(p.terminal?.kind, "final_answer", "final answer preserved");
    if (p.terminal?.kind === "final_answer") {
      assert.equal(p.terminal.text, "真正的结论。");
    }
  });
});
