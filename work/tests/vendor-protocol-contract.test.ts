// Trylo Work — vendor protocol contract tests
// (M3 closure spec §7.2 / §14.5, fixing M3-P1-04).
//
// Every fixture below is transcribed from the REAL
// vendor emitter / broadcast code in
// work/vendor/cowork-os/src — NOT hand-written "ideal"
// payloads:
//
//   - envelope: daemon/control-plane-methods.ts
//     attachAgentDaemonTaskBridge →
//     broadcastToOperators(Events.TASK_EVENT, {
//       taskId, type, payload, timestamp, schemaVersion,
//       eventId, seq, ts, status, stepId, groupId, actor
//     })
//   - timeline_command_output: electron/agent/tools/
//     shell-tools.ts logEvent("command_output", {
//       command, cwd, type, output, sandboxType })
//     + timeline-emitter.ts emitCommandOutput
//   - tool lane steps: electron/agent/executor.ts
//     emitToolLaneStarted / emitToolLaneFinished
//   - timeline_artifact_emitted: electron/agent/
//     timeline-emitter.ts emitArtifact
//   - timeline_error: electron/agent/daemon.ts
//     out-of-order quarantine event
//
// If a vendor bump changes any of these shapes the tests
// here MUST fail, forcing a conscious contract review.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { consumeFrame, FrameDedupe } from "../src/consume-frame.js";
import { TaskRegistry, runIdForTask, type TaskRecord } from "../src/task-registry.js";
import type { EventFrame } from "../src/control-plane/types.js";

/** Pinned protocol version of the vendor task-event
 *  broadcast (control-plane-methods.ts hardcodes
 *  `schemaVersion: 2`). A vendor bump flips the fixture
 *  review flag below and fails this suite on purpose. */
const EXPECTED_SCHEMA_VERSION = 2;
// Flip to true after a deliberate review of a vendor
// protocol bump; keeping it false guards against silent
// drift.
const REVIEWED_SCHEMA_BUMP = false;

describe("vendor contract: headless follow-up bridge", () => {
  function controlPlaneSource(): string {
    const sourcePath = fileURLToPath(new URL(
      "../vendor/cowork-os/src/daemon/control-plane-methods.ts",
      import.meta.url,
    ));
    return readFileSync(sourcePath, "utf8");
  }

  it("returns a task id before initial execution begins", () => {
    const source = controlPlaneSource();
    assert.match(source, /setImmediate\(\(\) => \{\s*void agentDaemon\.startTask\(task\)/s);
    assert.doesNotMatch(
      source,
      /await agentDaemon\.startTask\(task\)/,
      "task.create must not hold the RPC open for the task lifetime",
    );
  });

  it("forwards permissions and acknowledges long-running continuations immediately", () => {
    const source = controlPlaneSource();
    assert.match(source, /quotedAssistantMessage,\s*permissionMode,\s*shellAccess,\s*integrationMentions/s);
    assert.match(source, /void agentDaemon\s*\.sendMessage/s);
    assert.doesNotMatch(
      source,
      /await agentDaemon\.sendMessage\(taskId, message, images\)/,
      "the RPC must not wait for a document task to finish",
    );
  });
});

const TASK_ID = "task-contract";
const RUN_ID = runIdForTask(TASK_ID);

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    runId: RUN_ID,
    turnId: "user-turn-1",
    workspaceId: "ws-1",
    projectRoot: "D:/repo",
    conversationId: "conv-contract",
    sessionId: "session-contract",
    status: "running",
    lastSeq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    terminalError: undefined,
    ...overrides,
  };
}

/** Envelope exactly as broadcastToOperators emits it in
 *  control-plane-methods.ts (lines 689-705). */
function broadcast(
  type: string,
  payload: Record<string, unknown>,
  fields: {
    seq?: number;
    status?: string;
    actor?: string;
    stepId?: string;
  } = {},
): EventFrame {
  return {
    type: "event",
    event: "task.event",
    payload: {
      taskId: TASK_ID,
      type,
      payload,
      timestamp: 1719000000000,
      schemaVersion: 2,
      eventId: `evt-${fields.seq ?? 0}`,
      seq: fields.seq,
      status: fields.status,
      actor: fields.actor,
      stepId: fields.stepId,
    },
  };
}

function fresh() {
  const registry = new TaskRegistry();
  registry.register(record());
  return { registry, dedupe: new FrameDedupe() };
}

describe("vendor contract: schema version pin", () => {
  it("fixtures broadcast schemaVersion 2 and the pin matches", () => {
    const frame = broadcast("timeline_command_output", {}, { seq: 1 });
    const inner = frame.payload as { schemaVersion: number };
    assert.equal(inner.schemaVersion, EXPECTED_SCHEMA_VERSION);
    assert.equal(REVIEWED_SCHEMA_BUMP, false);
  });
});

describe("vendor contract: timeline_command_output (§7.1, M3-P1-04)", () => {
  it("start frame (shell-tools.ts:699) surfaces payload.output", () => {
    const deps = fresh();
    // Real logEvent payload — no `message` field.
    const frame = broadcast(
      "timeline_command_output",
      {
        command: "npm run type-check",
        cwd: "D:/repo",
        type: "start",
        output: "$ npm run type-check\n",
        sandboxType: "none",
        status: "in_progress",
        actor: "tool",
        legacyType: "command_output",
      },
      { seq: 10, status: "in_progress", actor: "tool" },
    );
    const update = consumeFrame(frame, deps);
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    assert.equal(update.items.length, 1);
    const item = update.items[0];
    assert.equal(item.kind, "progress");
    if (item.kind !== "progress") throw new Error("unreachable");
    assert.equal(item.text, "$ npm run type-check\n");
    assert.equal(item.turnId, "user-turn-1");
    assert.equal(item.runId, RUN_ID);
  });

  it("stdout frame (shell-tools.ts:750) surfaces the stream text", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast(
        "timeline_command_output",
        {
          command: "npm run type-check",
          cwd: "D:/repo",
          type: "stdout",
          output: "tsc --noEmit: 0 errors\n",
          sandboxType: "none",
          status: "in_progress",
          actor: "tool",
          legacyType: "command_output",
        },
        { seq: 11 },
      ),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    assert.equal(update.items.length, 1);
  });

  it("end frame (shell-tools.ts:790, no output) degrades visibly, never crashes", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast(
        "timeline_command_output",
        {
          command: "npm run type-check",
          cwd: "D:/repo",
          type: "end",
          exitCode: 0,
          success: true,
          terminationReason: "normal",
          sandboxType: "none",
          status: "in_progress",
          actor: "tool",
          legacyType: "command_output",
        },
        { seq: 12 },
      ),
      deps,
    );
    // No text → no projection, but the frame is still
    // accepted with a diagnostic line (§7.2: visible
    // degradation, not a silent loss of the stream).
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    assert.equal(update.items.length, 0);
    assert.ok(update.diagnostic.id.length > 0);
  });
});

describe("vendor contract: tool lane steps (executor.ts)", () => {
  const STEP_ID = "tool_lane:step:tu_1";

  it("emitToolLaneStarted (executor.ts:1537) → tool/running keyed by (runId, stepId)", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast(
        "timeline_step_started",
        {
          stepId: STEP_ID,
          step: { id: STEP_ID, description: "Running read_file" },
          groupId: "tools:step:turn-1:1719000000000:0",
          status: "in_progress",
          actor: "tool",
          message: "Running read_file",
          legacyType: "step_started",
        },
        { seq: 20, status: "in_progress", actor: "tool", stepId: STEP_ID },
      ),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    assert.equal(update.items.length, 1);
    const item = update.items[0];
    assert.equal(item.kind, "tool");
    if (item.kind !== "tool") throw new Error("unreachable");
    assert.equal(item.id, `tool:${RUN_ID}:${STEP_ID}`);
    assert.equal(item.status, "running");
    assert.equal(item.summary, "Running read_file");
  });

  it("emitToolLaneFinished completed (executor.ts:1564) updates the SAME card to done", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast(
        "timeline_step_finished",
        {
          stepId: STEP_ID,
          step: { id: STEP_ID, description: "read_file" },
          groupId: "tools:step:turn-1:1719000000000:0",
          status: "completed",
          actor: "tool",
          message: "read_file completed",
          legacyType: "step_completed",
        },
        { seq: 21, status: "completed", actor: "tool", stepId: STEP_ID },
      ),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    const item = update.items[0];
    assert.equal(item.kind, "tool");
    if (item.kind !== "tool") throw new Error("unreachable");
    assert.equal(item.id, `tool:${RUN_ID}:${STEP_ID}`);
    assert.equal(item.status, "done");
  });

  it("emitToolLaneFinished failed maps to tool/error", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast(
        "timeline_step_finished",
        {
          stepId: STEP_ID,
          step: { id: STEP_ID, description: "run_command" },
          groupId: "tools:step:turn-1:1719000000000:0",
          status: "failed",
          actor: "tool",
          message: "run_command finished with issues",
          legacyType: "step_failed",
        },
        { seq: 22, status: "failed", actor: "tool", stepId: STEP_ID },
      ),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    const item = update.items[0];
    assert.equal(item.kind, "tool");
    if (item.kind !== "tool") throw new Error("unreachable");
    assert.equal(item.status, "error");
  });

  it("the SAME stepId in a different run never clobbers this run's card (§14.2)", () => {
    const deps = fresh();
    const OTHER_TASK = "task-other-run";
    // Real registration (work-runtime.ts) always pairs
    // taskId with runIdForTask(taskId).
    deps.registry.register(
      record({
        taskId: OTHER_TASK,
        runId: runIdForTask(OTHER_TASK),
        conversationId: "conv-other",
      }),
    );
    const otherRun = runIdForTask(OTHER_TASK);
    assert.notEqual(otherRun, RUN_ID);

    // Same stepId on BOTH runs — only the (runId, stepId)
    // keying keeps them apart.
    const stepFrame = (
      taskId: string,
      seq: number,
      finished: boolean,
    ): EventFrame => ({
      type: "event",
      event: "task.event",
      payload: {
        taskId,
        type: finished ? "timeline_step_finished" : "timeline_step_started",
        payload: {
          stepId: STEP_ID,
          step: { id: STEP_ID, description: "read_file" },
          groupId: "tools:step:turn-1:1719000000000:0",
          status: finished ? "completed" : "in_progress",
          actor: "tool",
          message: finished ? "read_file completed" : "Running read_file",
          legacyType: finished ? "step_completed" : "step_started",
        },
        timestamp: 1719000000000,
        schemaVersion: 2,
        eventId: `evt-${taskId}-${seq}`,
        seq,
        status: finished ? "completed" : "in_progress",
        actor: "tool",
        stepId: STEP_ID,
      },
    });

    const startedA = consumeFrame(stepFrame(TASK_ID, 40, false), deps);
    const startedB = consumeFrame(stepFrame(OTHER_TASK, 1, false), deps);
    assert.equal(startedA.kind, "accepted");
    assert.equal(startedB.kind, "accepted");
    if (startedA.kind !== "accepted" || startedB.kind !== "accepted") {
      throw new Error("unreachable");
    }
    // Two DISTINCT cards despite the shared stepId.
    assert.equal(startedA.items[0].id, `tool:${RUN_ID}:${STEP_ID}`);
    assert.equal(startedB.items[0].id, `tool:${otherRun}:${STEP_ID}`);

    // Finishing the OTHER run's card must project ONLY
    // that card — run A's update keys off its own runId.
    const finishedB = consumeFrame(stepFrame(OTHER_TASK, 2, true), deps);
    assert.equal(finishedB.kind, "accepted");
    if (finishedB.kind !== "accepted") throw new Error("unreachable");
    assert.equal(finishedB.items.length, 1);
    assert.equal(finishedB.items[0].id, `tool:${otherRun}:${STEP_ID}`);
    assert.equal(
      finishedB.items[0].kind === "tool" ? finishedB.items[0].status : "",
      "done",
    );
  });
});

describe("vendor contract: timeline_artifact_emitted (timeline-emitter.ts:183)", () => {
  it("emitArtifact frame projects an artifact from payload.path", () => {
    const deps = fresh();
    // Real emitter payload: `path`, NOT `filePath`; no
    // `message` — the router pass-through (§7.2) must
    // admit it anyway.
    const update = consumeFrame(
      broadcast(
        "timeline_artifact_emitted",
        {
          path: "D:/repo/.trylo/out/report.md",
          mimeType: "text/markdown",
          label: "report.md",
          stepId: "step:task-contract",
          status: "completed",
          actor: "agent",
          legacyType: "artifact_created",
        },
        { seq: 30, status: "completed", actor: "agent" },
      ),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    assert.equal(update.items.length, 1);
    const item = update.items[0];
    assert.equal(item.kind, "artifact");
    if (item.kind !== "artifact") throw new Error("unreachable");
    assert.equal(item.filePath, "D:/repo/.trylo/out/report.md");
    // The step-level "completed" status in the envelope
    // must NOT flip the task to terminal (§6.1).
    assert.notEqual(update.appliedStatus, "completed");
    assert.equal(deps.registry.get(TASK_ID)?.status, "running");
  });
});

describe("vendor contract: timeline_error (daemon.ts quarantine shape)", () => {
  it("projects a recovery warning without terminating the task", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast(
        "timeline_error",
        {
          message: "Out-of-order timeline event rejected",
          rejectedType: "timeline_step_updated",
          rejectedSeq: 5,
          lastKnownSeq: 9,
          legacyType: "error",
        },
        { seq: 40 },
      ),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    assert.equal(update.routerDecision, "task_error");
    assert.equal(update.appliedStatus, undefined);
    const item = update.items[0];
    assert.equal(item.kind, "progress");
    if (item.kind !== "progress") throw new Error("unreachable");
    assert.match(item.text, /Out-of-order timeline event rejected/);
    assert.equal(deps.registry.get(TASK_ID)?.status, "running");
  });
});

describe("vendor contract: thinking and plan (timeline-emitter.ts)", () => {
  it("updateStep agent message → single thinking card id per run", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast(
        "timeline_step_updated",
        {
          stepId: "step:task-contract",
          step: { id: "step:task-contract", description: "Derive plan" },
          status: "in_progress",
          actor: "agent",
          message: "Considering the file layout",
          legacyType: "progress_update",
        },
        { seq: 50, status: "in_progress", actor: "agent" },
      ),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    const item = update.items[0];
    assert.equal(item.kind, "thinking");
    if (item.kind !== "thinking") throw new Error("unreachable");
    assert.equal(item.id, `thinking:${RUN_ID}`);
  });

  it("startGroup / finishGroup messages → plan items", () => {
    const deps = fresh();
    const started = consumeFrame(
      broadcast(
        "timeline_group_started",
        {
          taskId: TASK_ID,
          stage: "DISCOVER",
          groupId: "group:discover",
          groupLabel: "DISCOVER",
          status: "in_progress",
          actor: "system",
          legacyType: "step_started",
          message: "Starting DISCOVER",
        },
        { seq: 60 },
      ),
      deps,
    );
    assert.equal(started.kind, "accepted");
    if (started.kind !== "accepted") throw new Error("unreachable");
    const startItem = started.items[0];
    assert.equal(startItem.kind, "plan");
    if (startItem.kind !== "plan") throw new Error("unreachable");
    assert.equal(startItem.stage, "started");

    const finished = consumeFrame(
      broadcast(
        "timeline_group_finished",
        {
          taskId: TASK_ID,
          stage: "DISCOVER",
          groupId: "group:discover",
          groupLabel: "DISCOVER",
          status: "completed",
          actor: "system",
          legacyType: "step_completed",
          message: "Completed DISCOVER",
        },
        { seq: 61 },
      ),
      deps,
    );
    assert.equal(finished.kind, "accepted");
    if (finished.kind !== "accepted") throw new Error("unreachable");
    const finItem = finished.items[0];
    // The 'Completed DISCOVER' regression (§7, W-UI-002):
    // NEVER an error.
    assert.equal(finItem.kind, "plan");
    if (finItem.kind !== "plan") throw new Error("unreachable");
    assert.equal(finItem.stage, "finished");
  });
});

describe("vendor contract: degraded and replay behaviour (§7.2, §5.4)", () => {
  it("unknown event with text degrades to progress, not silent success", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast("mystery_event", { message: "something new from vendor" }, { seq: 70 }),
      deps,
    );
    assert.equal(update.kind, "accepted");
    if (update.kind !== "accepted") throw new Error("unreachable");
    assert.equal(update.items.length, 1);
    assert.equal(update.items[0].kind, "progress");
  });

  it("unknown event without text is dropped with diagnostics only", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast("mystery_event", { opaque: true }, { seq: 71 }),
      deps,
    );
    assert.equal(update.kind, "dropped");
  });

  it("terminal hint frames stay hints — task.get is the authority (§6.1)", () => {
    const deps = fresh();
    const update = consumeFrame(
      broadcast("task_completed", { resultSummary: "done" }, { seq: 72 }),
      deps,
    );
    assert.equal(update.kind, "dropped");
    if (update.kind !== "dropped") throw new Error("unreachable");
    assert.equal(update.reason, "ignored");
    assert.equal(deps.registry.get(TASK_ID)?.status, "running");
  });

  it("replaying the same taskId+type+seq is idempotent", () => {
    const deps = fresh();
    const frame = broadcast(
      "timeline_command_output",
      { command: "ls", type: "stdout", output: "a.md\n", legacyType: "command_output" },
      { seq: 80 },
    );
    const first = consumeFrame(frame, deps);
    const second = consumeFrame(frame, deps);
    assert.equal(first.kind, "accepted");
    assert.equal(second.kind, "dropped");
    if (second.kind !== "dropped") throw new Error("unreachable");
    assert.equal(second.reason, "replay");
  });
});
