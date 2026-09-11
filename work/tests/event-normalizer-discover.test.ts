// Trylo Work — EventNormalizer regression: a "Completed
// DISCOVER" message must NEVER be classified as a task
// failure.
//
// v1.16.5+ (W-UI-002, Phase 3 of the M1 lifecycle
// milestone): the previous implementation of
// isErrorEvent only short-circuited the inner `type`
// values it explicitly knew. The upstream `task.event`
// inner types `timeline_group_started`,
// `timeline_group_finished`, `timeline_step_started`,
// `timeline_step_updated`, `timeline_step_finished`,
// `timeline_evidence_attached`,
// `timeline_artifact_emitted`, and
// `timeline_command_output` all carry a nested
// `payload.message`. When the message is non-empty the
// old code's defensive branch (`typeof payload.payload.
// message === "string"`) returned true, so a frame
// like
//     { type: "timeline_group_finished",
//       payload: { message: "Completed DISCOVER" } }
// was routed into the error branch and rendered as
// "Task failed: Completed DISCOVER" — even though
// the underlying agent continued running and produced
// a real artifact later. This fixture pins the fix:
// the message is real plan-stage telemetry, not a
// failure.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isErrorEvent, normalizeError } from "../src/event-normalizer.js";
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

describe("EventNormalizer: 'Completed DISCOVER' is NOT an error", () => {
  it("timeline_group_finished with message is not an error event", () => {
    const frame = taskEvent({
      taskId: "t1",
      type: "timeline_group_finished",
      payload: { message: "Completed DISCOVER" },
    });
    assert.equal(
      isErrorEvent(frame),
      false,
      "timeline_group_finished with a message must not be classified as an error",
    );
    assert.equal(
      normalizeError(frame),
      null,
      "normalizeError must not produce a userMessage for a group-finished event",
    );
  });

  it("timeline_group_started with message is not an error event", () => {
    const frame = taskEvent({
      taskId: "t1",
      type: "timeline_group_started",
      payload: { message: "DISCOVER" },
    });
    assert.equal(isErrorEvent(frame), false);
    assert.equal(normalizeError(frame), null);
  });

  it("timeline_step_finished with message is not an error event", () => {
    const frame = taskEvent({
      taskId: "t1",
      type: "timeline_step_finished",
      payload: { message: "Step 1 done" },
    });
    assert.equal(isErrorEvent(frame), false);
    assert.equal(normalizeError(frame), null);
  });

  it("timeline_artifact_emitted with a payload is not an error event", () => {
    const frame = taskEvent({
      taskId: "t1",
      type: "timeline_artifact_emitted",
      payload: {
        filePath: "D:/repo/.trylo/out/test-work.txt",
        kind: "document",
      },
    });
    assert.equal(isErrorEvent(frame), false);
    assert.equal(normalizeError(frame), null);
  });

  it("real timeline_error with a message IS still classified as an error", () => {
    // The fix must not over-correct: a genuine
    // timeline_error with a message is still an error.
    const frame = taskEvent({
      taskId: "t1",
      type: "timeline_error",
      payload: { message: "Completion blocked" },
    });
    assert.equal(isErrorEvent(frame), true);
    const norm = normalizeError(frame);
    assert.ok(norm !== null);
    assert.equal(norm.userMessage, "Completion blocked");
  });
});
