// Trylo Work — WorkRuntime terminal projection tests.
//
// v1.16.5+ (M3 closure spec §6.2, M3-P1-01): every run
// produces EXACTLY ONE user-visible terminal item. The
// registry is the trigger; task.get (reconciler /
// reconcileProject) is the authority that moves it to a
// terminal status. These tests pin:
//   - completed → final with the fallback explainer text
//   - failed → error whose diagnosticId matches the
//     drawer line pushed alongside
//   - cancelled → an explicit cancelled state
//   - exactly-once even under repeated terminal notices
//   - transient frame errors do not steal the terminal slot

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WorkRuntime } from "../src/work-runtime.js";
import { runIdForTask, type TaskRecord } from "../src/task-registry.js";
import type { ControlPlaneClient, EventFrame } from "../src/control-plane/types.js";
import type { RuntimeUpdate } from "../src/consume-frame.js";

function clientStub(
  send?: (method: string, params?: unknown) => Promise<unknown>,
): ControlPlaneClient {
  return {
    status: () => "connected",
    connect: () => {},
    disconnect: () => {},
    send: send ?? (async () => ({})),
    whenReady: async () => {},
    on: () => () => {},
  };
}

const tauriStub = { invoke: async <T,>(): Promise<T> => ({}) as T };

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
    status: "running",
    lastSeq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    terminalError: undefined,
    ...over,
  };
}

function makeRuntime(
  updates: RuntimeUpdate[],
): WorkRuntime {
  return new WorkRuntime({
    client: clientStub(),
    tauri: tauriStub,
    events: {
      onRuntimeUpdate: (update) => updates.push(update),
    },
  });
}

/** Drain queued microtasks (the terminal projection is
 *  deferred by one queueMicrotask). */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("WorkRuntime: exactly-once terminal projection", () => {
  it("completed → ONE final item with a content-bearing fallback", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord());
    rt.registry.update("task-1", { status: "completed", updatedAt: 2000 });
    await flush();
    assert.equal(updates.length, 1);
    const u = updates[0];
    assert.equal(u.kind, "accepted");
    if (u.kind !== "accepted") return;
    assert.equal(u.routerDecision, "terminal_projection");
    assert.equal(u.items.length, 1);
    const item = u.items[0];
    assert.equal(item.kind, "final");
    if (item.kind !== "final") return;
    assert.equal(item.id, `final:${runIdForTask("task-1")}`);
    // The forbidden placeholder is gone: a completed run always
    // lands on a real (if deterministic) conclusion.
    assert.ok(!item.text.includes("未返回文本结论"), `placeholder leaked: ${item.text}`);
    assert.equal(item.text, "已完成。");
    assert.equal(item.turnId, undefined);
    assert.equal(u.diagnostic.event, "task.terminal");
    // No natural-language final was recoverable → the diagnostics
    // code is recorded, never shown in the final item itself.
    assert.ok(u.diagnostic.summary.includes("missing_final_answer"));
  });

  it("failed → error item whose diagnosticId matches the drawer line", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord());
    rt.registry.update("task-1", {
      status: "failed",
      terminalError: "quota exceeded",
      updatedAt: 2000,
    });
    await flush();
    assert.equal(updates.length, 1);
    const u = updates[0];
    if (u.kind !== "accepted") throw new Error("expected accepted");
    const item = u.items[0];
    assert.equal(item.kind, "error");
    if (item.kind !== "error") return;
    assert.equal(item.userMessage, "quota exceeded");
    assert.equal(item.diagnosticId, u.diagnostic.id);
    assert.equal(item.id, `error:${runIdForTask("task-1")}:${u.diagnostic.id}`);
  });

  it("cancelled → explicit cancelled state, not success or failure", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord());
    rt.registry.update("task-1", { status: "cancelled", updatedAt: 2000 });
    await flush();
    assert.equal(updates.length, 1);
    const u = updates[0];
    if (u.kind !== "accepted") throw new Error("expected accepted");
    assert.equal(u.items[0]?.kind, "cancelled");
  });

  it("repeated terminal notices never double-project", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord());
    rt.registry.update("task-1", { status: "completed", updatedAt: 2000 });
    // The registry rejects terminal → terminal moves, but
    // even an identical re-write attempt and a late
    // deactivated notification must not project again.
    rt.registry.update("task-1", { updatedAt: 3000 });
    await flush();
    rt.registry.update("task-1", { status: "completed", updatedAt: 4000 });
    await flush();
    assert.equal(updates.length, 1);
  });

  it("a recovery re-register of an ALREADY terminal task still projects", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord({ status: "completed" }));
    await flush();
    assert.equal(updates.length, 1);
    const u = updates[0];
    if (u.kind !== "accepted") throw new Error("expected accepted");
    assert.equal(u.items[0]?.kind, "final");
  });

  it("a transient task_error keeps the binding alive and allows a later final", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord());
    const frame: EventFrame = {
      type: "event",
      event: "task.event",
      payload: {
        taskId: "task-1",
        type: "error",
        seq: 7,
        error: "boom",
      },
    };
    const update = rt.consumeFrame(frame);
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") return;
    assert.equal(update.items[0]?.kind, "progress");
    assert.equal(rt.registry.get("task-1")?.status, "running");
    rt.registry.update("task-1", { status: "completed", updatedAt: 2000 });
    await flush();
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.kind, "accepted");
    if (updates[0]?.kind === "accepted") assert.equal(updates[0].items[0]?.kind, "final");
  });

  it("dropped frames produce no terminal side effects", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    const update = rt.consumeFrame({
      type: "event",
      event: "task.event",
      payload: { taskId: "ghost", type: "timeline_step_updated", seq: 1 },
    });
    assert.equal(update.kind, "dropped");
    await flush();
    assert.equal(updates.length, 0);
  });
});

describe("WorkRuntime: recovery (spec §5.3/§5.4, M3-P0-02)", () => {
  it("registers recovered tasks with the daemon's REAL status, never pending", async () => {
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.get") {
          return { task: { id: "task-9", status: "executing", workspaceId: "ws-9" } };
        }
        return {};
      }),
      tauri: tauriStub,
    });
    await rt.reconcileProject({
      projectRoot: "D:/repo",
      persisted: new Map([["conv-9", "task-9"]]),
      turnIds: new Map([["conv-9", "u9"]]),
    });
    const record = rt.registry.getByConversation("conv-9");
    assert.ok(record);
    assert.equal(record.status, "running"); // executing maps to running
    assert.equal(record.turnId, "u9");
  });

  it("a vanished task emits a visible error and fires onStaleBinding", async () => {
    const updates: RuntimeUpdate[] = [];
    const stale: Array<{ projectRoot: string; conversationId: string }> = [];
    const rt = new WorkRuntime({
      client: clientStub(async () => ({ task: null })),
      tauri: tauriStub,
      events: {
        onRuntimeUpdate: (u) => updates.push(u),
        onStaleBinding: (args) => stale.push(args),
      },
    });
    await rt.reconcileProject({
      projectRoot: "D:/repo",
      persisted: new Map([["conv-1", "task-x"]]),
    });
    assert.equal(stale.length, 1);
    assert.deepEqual(stale[0], { projectRoot: "D:/repo", conversationId: "conv-1" });
    assert.equal(updates.length, 1);
    const u = updates[0];
    if (u.kind !== "accepted") throw new Error("expected accepted");
    const item = u.items[0];
    assert.equal(item.kind, "error");
    if (item.kind !== "error") return;
    assert.equal(item.diagnosticId, u.diagnostic.id);
    assert.equal(item.conversationId, "conv-1");
  });

  it("concurrent reconcileProject calls share ONE flight (no task.get burst)", async () => {
    let getCalls = 0;
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.get") {
          getCalls += 1;
          await new Promise((r) => setTimeout(r, 10));
          return { task: { id: "task-9", status: "running", workspaceId: "ws-9" } };
        }
        return {};
      }),
      tauri: tauriStub,
    });
    const persisted = new Map([["conv-9", "task-9"]]);
    // StrictMode-style duplicate effect: two concurrent
    // calls must produce a single task.get round.
    await Promise.all([
      rt.reconcileProject({ projectRoot: "D:/repo", persisted }),
      rt.reconcileProject({ projectRoot: "D:/repo", persisted }),
    ]);
    assert.equal(getCalls, 1);
    // A later call (fingerprint changed) runs again.
    await rt.reconcileProject({ projectRoot: "D:/repo", persisted });
    assert.equal(getCalls, 2);
  });

  it("a failing task.get never leaves recovery pending or throws (§14.3)", async () => {
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.get") {
          throw new Error("[ControlPlane] task.get timed out after 10000ms");
        }
        return {};
      }),
      tauri: tauriStub,
    });
    // Resolves despite the failure — the effect's await
    // can never hang the renderer on a dead daemon.
    await rt.reconcileProject({
      projectRoot: "D:/repo",
      persisted: new Map([["conv-1", "task-x"]]),
    });
    // No phantom binding registered from a failed lookup.
    assert.equal(rt.registry.getByConversation("conv-1"), undefined);
    // The failure did not poison the single-flight guard:
    // the next attempt runs again.
    let calls = 0;
    const rt2 = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.get") {
          calls += 1;
          throw new Error("boom");
        }
        return {};
      }),
      tauri: tauriStub,
    });
    const persisted = new Map([["conv-1", "task-x"]]);
    await Promise.all([
      rt2.reconcileProject({ projectRoot: "D:/repo", persisted }),
      rt2.reconcileProject({ projectRoot: "D:/repo", persisted }),
    ]);
    assert.equal(calls, 1);
    await rt2.reconcileProject({ projectRoot: "D:/repo", persisted });
    assert.equal(calls, 2);
  });
});

describe("WorkRuntime: decision-card recovery after refresh (M4-E P1)", () => {
  it("recovers a live input card when a pause narration arrives without its event", async () => {
    const updates: RuntimeUpdate[] = [];
    const methods: string[] = [];
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        methods.push(method);
        if (method === "approval.list") return { approvals: [] };
        if (method === "input_request.list") {
          return {
            inputRequests: [{
              id: "ir-live", status: "pending",
              questions: [{ id: "q1", question: "请选择格式", options: ["A", "B"] }],
            }],
          };
        }
        return {};
      }),
      tauri: tauriStub,
      events: { onRuntimeUpdate: (u) => updates.push(u) },
    });
    rt.registry.register(makeRecord());
    rt.consumeFrame({
      type: "event", event: "task.event",
      payload: {
        taskId: "task-1", type: "timeline_step_updated", seq: 9,
        payload: { actor: "agent", message: "Paused - awaiting user input" },
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const restored = updates.flatMap((u) => u.kind === "accepted" ? u.items : []);
    assert.equal(restored.some((item) => item.kind === "input_request"), true);
    assert.equal(methods.includes("input_request.list"), true);
    await rt.dispose();
  });

  it("replays early task events after task ownership is registered", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    const early = rt.consumeFrame({
      type: "event",
      event: "task.event",
      payload: {
        taskId: "task-early",
        type: "timeline_step_updated",
        seq: 1,
        payload: { actor: "agent", message: "正在分析任务" },
      },
    });
    assert.equal(early.kind, "dropped");
    rt.registry.register(makeRecord({ taskId: "task-early" }));
    await flush();
    const replayed = updates.find((u) => u.kind === "accepted");
    assert.ok(replayed && replayed.kind === "accepted");
    if (replayed?.kind === "accepted") {
      assert.equal(replayed.items[0]?.kind, "thinking");
    }
  });

  it("reconcileProject restores PENDING approvals + input requests as cards", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.get") {
          return {
            task: {
              id: "task-9",
              status: "running",
              workspaceId: "ws-9",
            },
          };
        }
        if (method === "approval.list") {
          return {
            approvals: [
              {
                id: "ap-1",
                taskId: "task-9",
                type: "run_command",
                description: "Run shell command: git push",
                status: "pending",
                requestedAt: 1000,
              },
            ],
          };
        }
        if (method === "input_request.list") {
          return {
            inputRequests: [
              {
                id: "ir-1",
                taskId: "task-9",
                status: "pending",
                requestedAt: 1000,
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
              },
            ],
          };
        }
        return {};
      }),
      tauri: tauriStub,
      events: { onRuntimeUpdate: (u) => updates.push(u) },
    });
    await rt.reconcileProject({
      projectRoot: "D:/repo",
      persisted: new Map([["conv-9", "task-9"]]),
    });
    // reconcile runs restorePendingDecisions BEFORE resolving, so
    // the restored cards are already present.
    const restored = updates.filter((u) => u.kind === "accepted").flatMap((u) =>
      u.kind === "accepted" ? u.items : [],
    );
    const approval = restored.find((i) => i.kind === "approval");
    const inputRequest = restored.find((i) => i.kind === "input_request");
    assert.ok(approval && approval.kind === "approval");
    assert.equal(approval.approvalId, "ap-1");
    assert.equal(approval.status, "pending");
    assert.equal(approval.conversationId, "conv-9");
    assert.ok(inputRequest && inputRequest.kind === "input_request");
    assert.equal(inputRequest.requestId, "ir-1");
    assert.equal(inputRequest.status, "pending");
    assert.equal(inputRequest.questions.length, 1);
    // Stable id form so a later realtime `approval_granted` /
    // `input_request_resolved` upserts the SAME card (no dupes).
    assert.equal(approval.id, `approval:${approval.runId}:ap-1`);
    assert.equal(inputRequest.id, `input_request:${inputRequest.runId}:ir-1`);
  });

  it("does NOT restore already-resolved / non-pending decisions", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.get") {
          return { task: { id: "task-9", status: "running", workspaceId: "ws-9" } };
        }
        if (method === "approval.list") {
          // approved → never restored
          return {
            approvals: [{ id: "ap-done", status: "approved", type: "run_command" }],
          };
        }
        if (method === "input_request.list") {
          // dismissed → never restored
          return {
            inputRequests: [{ id: "ir-done", status: "dismissed", questions: [] }],
          };
        }
        return {};
      }),
      tauri: tauriStub,
      events: { onRuntimeUpdate: (u) => updates.push(u) },
    });
    await rt.reconcileProject({
      projectRoot: "D:/repo",
      persisted: new Map([["conv-9", "task-9"]]),
    });
    const items = updates
      .filter((u) => u.kind === "accepted")
      .flatMap((u) => (u.kind === "accepted" ? u.items : []));
    assert.equal(items.some((i) => i.kind === "approval"), false);
    assert.equal(items.some((i) => i.kind === "input_request"), false);
  });

  it("a decision-list failure never breaks recovery or throws", async () => {
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.get") {
          return { task: { id: "task-9", status: "running", workspaceId: "ws-9" } };
        }
        if (method === "approval.list" || method === "input_request.list") {
          throw new Error("[ControlPlane] list timed out");
        }
        return {};
      }),
      tauri: tauriStub,
    });
    // Resolves despite the list failure; the binding is unaffected.
    await rt.reconcileProject({
      projectRoot: "D:/repo",
      persisted: new Map([["conv-9", "task-9"]]),
    });
    assert.ok(rt.registry.getByConversation("conv-9"));
  });
});

describe("WorkRuntime: multi-turn follow-up (M4-B, §6.1)", () => {
  it("startTask creates once; sendMessage continues the SAME task with a NEW runId", async () => {
    let createCalls = 0;
    let sendCalls = 0;
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.create") {
          createCalls += 1;
          return { task: { id: "task-42" } };
        }
        if (method === "task.sendMessage") {
          sendCalls += 1;
          return {};
        }
        return {};
      }),
      tauri: tauriStub,
    });

    const taskId = await rt.startTask({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      sessionId: "conv-1",
      projectRoot: "D:/repo",
      title: "first",
      prompt: "hello",
      turnId: "turn-1",
    });
    assert.equal(taskId, "task-42");
    assert.equal(createCalls, 1);
    const firstRecord = rt.registry.get("task-42");
    assert.ok(firstRecord);
    assert.equal(firstRecord.delivery, "create");
    const firstRunId = firstRecord.runId;
    assert.ok(firstRunId);

    // First turn completes.
    rt.registry.update("task-42", { status: "completed" });
    assert.equal(rt.registry.getByConversation("conv-1"), undefined);

    // Second turn: follow-up on the same durable task.
    const runId2 = await rt.sendMessage({
      taskId: "task-42",
      message: "make it better",
      turnId: "turn-2",
    });
    assert.equal(sendCalls, 1);
    assert.equal(createCalls, 1); // still only one create
    const rec = rt.registry.get("task-42");
    assert.ok(rec);
    assert.equal(rec.taskId, "task-42"); // thread id unchanged
    assert.equal(rec.runId, runId2);
    assert.notEqual(rec.runId, firstRunId); // run id changed
    assert.equal(rec.delivery, "follow_up");
    assert.equal(rec.status, "starting");
    assert.equal(rec.turnId, "turn-2");
    assert.ok(rt.registry.getByConversation("conv-1")); // active again
  });

  it("a terminal task can be followed up and reach a terminal again", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.create") return { task: { id: "task-7" } };
        return {};
      }),
      tauri: tauriStub,
      events: { onRuntimeUpdate: (update) => updates.push(update) },
    });
    const taskId = await rt.startTask({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      sessionId: "conv-1",
      projectRoot: "D:/repo",
      title: "t",
      prompt: "p",
      turnId: "turn-1",
    });
    // Finish the first run.
    rt.registry.update(taskId, { status: "completed", updatedAt: 2000 });
    await flush();
    // Follow up.
    await rt.sendMessage({ taskId, message: "again", turnId: "turn-2" });
    // Let it complete again.
    rt.registry.update(taskId, { status: "completed", updatedAt: 3000 });
    await flush();
    // Two terminal projections total (one per run), never merged.
    const terminals = updates.filter(
      (u) => u.kind === "accepted" && u.routerDecision === "terminal_projection",
    );
    assert.equal(terminals.length, 2);
  });

  it("sendMessage on an unknown task throws", async () => {
    let sends = 0;
    const rt = new WorkRuntime({
      client: clientStub(async () => {
        sends += 1;
        return {};
      }),
      tauri: tauriStub,
    });
    await assert.rejects(
      rt.sendMessage({ taskId: "ghost", message: "hi", turnId: "t1" }),
      /WorkRuntime\.sendMessage: unknown taskId=ghost/,
    );
    assert.equal(sends, 0);
  });
});

describe("WorkRuntime: final-answer resolution (WP-3, spec §10)", () => {
  it("projects the recorded wrapped task_completed result as the live final", () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord({ intent: "conversation" }));

    const update = rt.consumeFrame({
      type: "event",
      event: "task.event",
      payload: {
        taskId: "task-1",
        type: "timeline_step_finished",
        seq: 157,
        payload: {
          legacyType: "task_completed",
          message: "Task completed successfully",
          resultSummary: "你好！很高兴见到你。",
        },
      },
    });

    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") return;
    assert.equal(update.items.length, 1);
    const item = update.items[0];
    assert.equal(item.kind, "final");
    assert.equal(item.intent, "conversation");
    if (item.kind === "final") {
      assert.equal(item.text, "你好！很高兴见到你。");
    }
  });

  it("steers or resumes the active run without replacing its runId", async () => {
    const sent: Array<{ method: string; params?: unknown }> = [];
    const rt = new WorkRuntime({
      client: clientStub(async (method, params) => {
        sent.push({ method, params });
        return {};
      }),
      tauri: tauriStub,
    });
    rt.registry.register(makeRecord({
      taskId: "task-live",
      runId: "run:original",
      status: "paused",
    }));

    await rt.steerTask({
      taskId: "task-live",
      message: "继续，改用蓝色主题",
      permissionMode: "accept_edits",
      shellAccess: true,
    });

    assert.equal(rt.registry.get("task-live")?.runId, "run:original");
    assert.equal(rt.registry.get("task-live")?.status, "running");
    assert.deepEqual(sent.at(-1), {
      method: "task.sendMessage",
      params: {
        taskId: "task-live",
        message: "继续，改用蓝色主题",
        permissionMode: "accept_edits",
        shellAccess: true,
      },
    });
  });

  it("quotes the last meaningful narration when the daemon sent no final", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord());
    rt.consumeFrame({
      type: "event",
      event: "task.event",
      payload: {
        taskId: "task-1",
        type: "timeline_step_updated",
        seq: 1,
        payload: { actor: "agent", message: "报告已生成，包含 3 个指标。" },
      },
    });
    rt.registry.update("task-1", { status: "completed", updatedAt: 2000 });
    await flush();
    const u = updates.find(
      (x) => x.kind === "accepted" && x.routerDecision === "terminal_projection",
    );
    assert.ok(u, "expected a terminal projection");
    if (u?.kind !== "accepted") return;
    const item = u.items[0];
    assert.equal(item.kind, "final");
    if (item.kind !== "final") return;
    assert.equal(item.text, "报告已生成，包含 3 个指标。");
    assert.ok(!u.diagnostic.summary.includes("missing_final_answer"));
  });

  it("builds a deterministic summary from observed facts when no final exists", async () => {
    const updates: RuntimeUpdate[] = [];
    const rt = makeRuntime(updates);
    rt.registry.register(makeRecord());
    rt.consumeFrame({
      type: "event",
      event: "task.event",
      payload: {
        taskId: "task-1",
        type: "timeline_artifact_emitted",
        seq: 1,
        payload: { filePath: "D:/repo/.trylo/out/report.md" },
      },
    });
    rt.registry.update("task-1", { status: "completed", updatedAt: 2000 });
    await flush();
    const u = updates.find(
      (x) => x.kind === "accepted" && x.routerDecision === "terminal_projection",
    );
    assert.ok(u, "expected a terminal projection");
    if (u?.kind !== "accepted") return;
    const item = u.items[0];
    assert.equal(item.kind, "final");
    if (item.kind !== "final") return;
    assert.ok(item.text.includes("report.md"), `expected artifact mention in "${item.text}"`);
    assert.ok(!item.text.includes("未返回文本结论"), "forbidden placeholder must never appear");
  });

  it("replays a bounded task.events page to recover a missed final", async () => {
    const updates: RuntimeUpdate[] = [];
    let eventsCalled = false;
    const rt = new WorkRuntime({
      client: clientStub(async (method) => {
        if (method === "task.events") {
          eventsCalled = true;
          return {
            events: [
              {
                id: "e1",
                taskId: "task-1",
                timestamp: 1,
                type: "timeline_step_updated",
                payload: { actor: "agent", message: "通过回放补回的结论。" },
              },
            ],
          };
        }
        return {};
      }),
      tauri: tauriStub,
      events: { onRuntimeUpdate: (u) => updates.push(u) },
    });
    rt.registry.register(makeRecord());
    rt.registry.update("task-1", { status: "completed", updatedAt: 2000 });
    await flush();
    assert.ok(eventsCalled, "missing final must trigger a task.events replay");
    const u = updates.find(
      (x) => x.kind === "accepted" && x.routerDecision === "terminal_projection",
    );
    assert.ok(u, "expected a terminal projection");
    if (u?.kind !== "accepted") return;
    const item = u.items[0];
    assert.equal(item.kind, "final");
    if (item.kind !== "final") return;
    assert.equal(item.text, "通过回放补回的结论。");
  });
});

describe("WorkRuntime: conversation forces plan (WP-1, spec §2.3)", () => {
  function recordingClient(): {
    sent: Array<{ method: string; params?: Record<string, unknown> }>;
    client: ControlPlaneClient;
  } {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = clientStub(async (method, params) => {
      sent.push({ method, params: params as Record<string, unknown> | undefined });
      if (method === "task.create") return { task: { id: "task-1" } };
      return {};
    });
    return { sent, client };
  }

  it("startTask forces plan for a chat turn regardless of the picker", async () => {
    const { sent, client } = recordingClient();
    const rt = new WorkRuntime({ client, tauri: tauriStub });
    await rt.startTask({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      sessionId: "conv-1",
      projectRoot: "D:/repo",
      title: "t",
      prompt: "hello",
      turnId: "t1",
      isChat: true,
      permissionMode: "dont_ask", // high picker must NOT leak
      shellAccess: true,
    });
    const create = sent.find((s) => s.method === "task.create");
    assert.ok(create);
    assert.equal(create.params?.permissionMode, "plan");
    // The chat companion gate reads `conversationMode: "chat"` (first turn
    // only); forwarding it is kept as the in-thread chat fallback.
    assert.deepEqual(create.params?.agentConfig, {
      permissionMode: "plan",
      conversationMode: "chat",
    });
    assert.equal(create.params?.shellAccess, undefined);
    assert.equal(rt.registry.get("task-1")?.intent, "conversation");
  });

  it("a task turn keeps the caller's permission mode", async () => {
    const { sent, client } = recordingClient();
    const rt = new WorkRuntime({ client, tauri: tauriStub });
    await rt.startTask({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      sessionId: "conv-1",
      projectRoot: "D:/repo",
      title: "t",
      prompt: "do work",
      turnId: "t1",
      isChat: false,
      permissionMode: "accept_edits",
      shellAccess: true,
    });
    const create = sent.find((s) => s.method === "task.create");
    assert.ok(create);
    assert.equal(create.params?.permissionMode, "accept_edits");
    assert.deepEqual(create.params?.agentConfig, { permissionMode: "accept_edits" });
    assert.equal(create.params?.shellAccess, true);
    assert.equal(rt.registry.get("task-1")?.intent, "task");
  });
});
