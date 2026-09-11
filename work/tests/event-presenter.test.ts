// Trylo Work — EventPresenter unit tests.
//
// v1.16.5+ (W-UI-002, Phase 3 of the M1 lifecycle
// milestone). Pins the "Completed DISCOVER" regression
// and the broader category mapping the presenter is
// responsible for.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { presentTaskEvent } from "../src/event-presenter.js";
import type { EventFrame } from "../src/control-plane/types.js";

function taskEvent(
  inner: Record<string, unknown>,
): EventFrame {
  return {
    type: "event",
    event: "task.event",
    payload: inner,
  };
}

describe("EventPresenter: 'Completed DISCOVER' is a plan, not an error", () => {
  it("timeline_group_finished 'Completed DISCOVER' → plan/finished", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_group_finished",
        payload: { message: "Completed DISCOVER" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "plan");
    if (out.kind === "plan") {
      assert.equal(out.stage, "finished");
      assert.equal(out.name, "Completed DISCOVER");
    }
  });

  it("timeline_group_started 'DISCOVER' → plan/started", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_group_started",
        payload: { message: "DISCOVER" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "plan");
    if (out.kind === "plan") {
      assert.equal(out.stage, "started");
      assert.equal(out.name, "DISCOVER");
    }
  });

  it("real timeline_error is still classified as an error (no over-correction)", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_error",
        payload: { message: "Completion blocked" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "error");
    if (out.kind === "error") {
      assert.equal(out.userMessage, "Completion blocked");
    }
  });
});

describe("EventPresenter: artifacts and tools", () => {
  it("timeline_artifact_emitted → artifact with filePath", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_artifact_emitted",
        payload: { filePath: "D:/repo/.trylo/out/test-work.txt", kind: "document" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "artifact");
    if (out.kind === "artifact") {
      assert.equal(out.filePath, "D:/repo/.trylo/out/test-work.txt");
      assert.equal(out.artifactKind, "document");
    }
  });

  it("timeline_artifact_emitted without filePath is dropped (malformed)", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_artifact_emitted",
        payload: { kind: "document" },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out, null);
  });

  it("timeline_artifact_emitted with vendor `path` field → artifact (compat)", () => {
    // The vendor emitter sends `path`, not `filePath`.
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_artifact_emitted",
        payload: { path: "D:/repo/.trylo/out/report.md", kind: "document" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "artifact");
    if (out.kind === "artifact") {
      assert.equal(out.filePath, "D:/repo/.trylo/out/report.md");
    }
  });

  it("timeline_command_output with text → progress", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_command_output",
        payload: { message: "$ ls\nREADME.md\nsrc\n" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "progress");
  });
});

describe("EventPresenter: step / progress", () => {
  it("timeline_step_finished with non-empty message → progress", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        payload: { message: "Step 1 done" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "progress");
  });

  it("timeline_step_finished with empty message is dropped (no noise)", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        payload: { message: "" },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out, null);
  });

  it("timeline_step_started with empty message is dropped", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_started",
        payload: { message: "   " },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out, null);
  });
});

describe("EventPresenter: tool steps (actor=tool) map to ToolCard items", () => {
  it("step_started with actor=tool → tool/running with stable id", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_started",
        payload: { actor: "tool", stepId: "s7", tool: "read_file", message: "Reading notes.md" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "tool");
    if (out.kind === "tool") {
      assert.equal(out.id, "tool:run:t1:s7");
      assert.equal(out.tool, "read_file");
      assert.equal(out.status, "running");
      assert.equal(out.summary, "Reading notes.md");
    }
  });

  it("step_finished with actor=tool → tool/done with the SAME id", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        payload: { actor: "tool", stepId: "s7", tool: "read_file", message: "Read notes.md" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "tool");
    if (out.kind === "tool") {
      assert.equal(out.id, "tool:run:t1:s7");
      assert.equal(out.status, "done");
    }
  });

  it("step_finished with status=failed → tool/error", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        payload: { actor: "tool", stepId: "s9", tool: "exec", status: "failed", message: "exec failed" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "tool");
    if (out.kind === "tool") {
      assert.equal(out.status, "error");
    }
  });

  it("tool step without stepId falls back to progress semantics", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_started",
        payload: { actor: "tool", message: "Running command" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "progress");
  });
});

describe("EventPresenter: agent reasoning (step_updated) maps to thinking", () => {
  it("step_updated with actor=agent and text → thinking", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        payload: { actor: "agent", message: "Considering the file layout" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "thinking");
    if (out.kind === "thinking") {
      assert.equal(out.text, "Considering the file layout");
    }
  });

  it("step_updated heartbeat (empty message) is dropped", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        payload: { actor: "agent", message: "" },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out, null);
  });

  it("step_updated from a tool actor is not thinking", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        payload: { actor: "tool", message: "streaming output" },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out, null);
  });
});

describe("EventPresenter: provider recovery", () => {
  it("turns a message-less llm_retry wrapper into concise progress", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        seq: 9,
        payload: { legacyType: "llm_retry", attempt: 2, maxRetries: 6 },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out?.kind, "progress");
    if (out?.kind === "progress") assert.match(out.text, /重试/);
  });

  it("shows a bounded in-flight notice before the hard model timeout", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        seq: 10,
        payload: { legacyType: "llm_slow", operation: "Plan creation" },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out?.kind, "progress");
    if (out?.kind === "progress") assert.match(out.text, /没有中断/);
  });

  it("shows deterministic plan recovery as continued execution", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        seq: 11,
        payload: { legacyType: "llm_plan_fallback" },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out?.kind, "progress");
    if (out?.kind === "progress") assert.match(out.text, /继续执行/);
  });
});

describe("EventPresenter: bookkeeping is hidden by default", () => {
  it("skill-routing-like frames are routed to diagnostics (hidden)", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "skill_invoked",
        payload: { message: "selected: web-search" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "diagnostics");
  });

  it("api_retry frames are routed to diagnostics (hidden)", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "api_retry",
        payload: { message: "retrying" },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "diagnostics");
  });
});

describe("EventPresenter: non-task events", () => {
  it("ignores non-task.event frames", () => {
    const frame: EventFrame = { type: "event", event: "task.created", payload: {} };
    const out = presentTaskEvent(frame, "t1", "run:t1");
    assert.equal(out, null);
  });
});

describe("EventPresenter: authoritative completion text", () => {
  it("unwraps a recorded timeline task_completed resultSummary as final", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        seq: 157,
        payload: {
          legacyType: "task_completed",
          message: "Task completed successfully",
          resultSummary: "你好！很高兴见到你。",
        },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "final");
    if (out.kind === "final") {
      assert.equal(out.id, "final:run:t1");
      assert.equal(out.text, "你好！很高兴见到你。");
    }
  });

  it("falls back to bestKnownOutcome.resultSummary", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        payload: {
          legacyType: "task_completed",
          message: "Task completed successfully",
          bestKnownOutcome: { resultSummary: "最终结果正文" },
        },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out?.kind, "final");
    if (out?.kind === "final") assert.equal(out.text, "最终结果正文");
  });

  it("does not project serialized tool-call residue as the final answer", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        payload: {
          legacyType: "task_completed",
          message: "Task completed successfully",
          resultSummary:
            '<seed:tool_call><function name="files_list">{"path":"."}</function></seed:tool_call>',
        },
      }),
      "t1",
      "run:t1",
    );
    assert.equal(out, null);
  });
});

describe("EventPresenter: phaseId / toolCallId identifiers (spec §5.2)", () => {
  it("tool steps carry toolCallId=stepId and phaseId from groupId", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_started",
        payload: {
          actor: "tool",
          stepId: "s7",
          tool: "read_file",
          message: "Reading notes.md",
          groupId: "group:discover",
        },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "tool");
    if (out.kind === "tool") {
      assert.equal(out.toolCallId, "s7");
      assert.equal(out.phaseId, "group:discover");
    }
  });

  it("agent thinking carries phaseId from groupId", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        payload: {
          actor: "agent",
          message: "Considering the layout",
          groupId: "group:discover",
        },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "thinking");
    if (out.kind === "thinking") {
      assert.equal(out.phaseId, "group:discover");
    }
  });

  it("command output carries the stepId for output routing (§6.4)", () => {
    const out = presentTaskEvent(
      taskEvent({
        taskId: "t1",
        type: "timeline_command_output",
        payload: {
          message: "$ ls\nREADME.md\nsrc\n",
          stepId: "s7",
          groupId: "group:discover",
        },
      }),
      "t1",
      "run:t1",
    );
    assert.ok(out !== null);
    if (out === null) throw new Error("unreachable");
    assert.equal(out.kind, "progress");
    if (out.kind === "progress") {
      assert.equal(out.toolCallId, "s7");
      assert.equal(out.phaseId, "group:discover");
    }
  });
});
