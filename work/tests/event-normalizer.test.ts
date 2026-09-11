// Trylo Work — Event normalizer tests (node:test).
//
// v1.16.5+ (Step 1, W-RUN-001 完整收口).
//
// Coverage map (matches the 5 shapes documented in
// event-normalizer.ts header):
//
//   Case A: timeline_error + nested message
//   Case B: timeline_error + no usable message
//   Case C: error event + string error
//   Case D: error event + Error-like / nested message
//   Case E: protocol upgrade / unrecognized shape
//
// Plus non-error returns, idempotence, and the
// "never produce literal 'unknown error'" invariant
// that the previous App.tsx implementation violated.
//
// Runs via `node --test tests/` per work/package.json —
// no vitest, no jest, no extra deps. See the agent
// conduct rule on not adding dependencies for one task.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isErrorEvent,
  normalizeError,
  type NormalizedError,
} from "../src/event-normalizer.js";
import type { EventFrame } from "../src/control-plane/types.js";

/** Tiny helper: build a minimal `task.event` frame
 *  with the given inner payload. */
function taskEvent(payload: unknown): EventFrame {
  return {
    type: "event",
    event: "task.event",
    payload,
  };
}

/** Helper: assert a NormalizedError is well-formed. */
function assertWellFormed(e: NormalizedError | null): asserts e is NormalizedError {
  assert.ok(e !== null, "expected a NormalizedError, got null");
  assert.equal(typeof e.userMessage, "string");
  assert.ok(e.userMessage.length > 0, "userMessage must be non-empty");
  assert.ok(
    e.userMessage !== "unknown error",
    `userMessage must NEVER be the literal 'unknown error' (got: ${JSON.stringify(
      e.userMessage,
    )})`,
  );
  // The user-facing string must also not contain the
  // "unknown error" substring in any casing (defence
  // against "Unknown Error" / "unknown errors: ...").
  assert.ok(
    !/unknown error/i.test(e.userMessage),
    `userMessage must NEVER contain 'unknown error' (got: ${JSON.stringify(
      e.userMessage,
    )})`,
  );
  assert.equal(typeof e.errorCode, "string");
  assert.ok(e.errorCode.length > 0);
  // taskId is optional (string | undefined) but when
  // present must be a string.
  if (e.taskId !== undefined) {
    assert.equal(typeof e.taskId, "string");
  }
  assert.equal(typeof e.rawEventType, "string");
  assert.equal(typeof e.diagnosticId, "string");
  assert.match(
    e.diagnosticId,
    /^err-[a-z0-9]+-[a-z0-9]+$/,
    "diagnosticId must match err-<ts>-<counter>",
  );
  assert.ok("raw" in e, "raw must be present for diagnostics");
}

// ---- Case A: timeline_error + nested message --------------------------

describe("normalizeError: Case A (timeline_error + nested message)", () => {
  it("extracts the message from frame.payload.payload.message", () => {
    const frame = taskEvent({
      taskId: "task-123",
      type: "timeline_error",
      payload: { message: "Completion blocked: unresolved failed step" },
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.userMessage, "Completion blocked: unresolved failed step");
    assert.equal(result.errorCode, "timeline_error");
    assert.equal(result.taskId, "task-123");
    assert.equal(result.rawEventType, "timeline_error");
    assert.equal(result.diagnosticId.length > 0, true);
  });

  it("also accepts a top-level message (defensive fallback)", () => {
    const frame = taskEvent({
      taskId: "task-456",
      type: "timeline_error",
      message: "older protocol: message at top level",
      // no nested `payload` object
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.userMessage, "older protocol: message at top level");
    assert.equal(result.errorCode, "timeline_error");
  });

  it("ignores whitespace-only messages and falls through to the no-message branch", () => {
    const frame = taskEvent({
      taskId: "task-whitespace",
      type: "timeline_error",
      payload: { message: "   " },
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "timeline_error_no_message");
  });
});

// ---- Case B: timeline_error + no message ------------------------------

describe("normalizeError: Case B (timeline_error + no usable message)", () => {
  it("produces a diagnostic and NEVER the literal 'unknown error'", () => {
    const frame = taskEvent({
      taskId: "task-empty",
      type: "timeline_error",
      payload: {},
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "timeline_error_no_message");
    assert.notEqual(result.userMessage, "unknown error");
    assert.match(result.userMessage, /diagnostic err-/);
    assert.ok(result.userMessage.includes("task-empty"), "taskId should be surfaced");
  });

  it("handles missing payload object entirely", () => {
    const frame = taskEvent({
      taskId: "task-nested-missing",
      type: "timeline_error",
      // no `payload` field at all
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "timeline_error_no_message");
  });

  it("handles missing taskId gracefully (no '(task undefined)' leak)", () => {
    const frame = taskEvent({
      type: "timeline_error",
      payload: {},
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.taskId, undefined);
    assert.ok(
      !/task undefined/.test(result.userMessage),
      `userMessage must not leak the literal 'undefined' for missing taskId (got: ${JSON.stringify(
        result.userMessage,
      )})`,
    );
  });
});

// ---- Case C: error event + string error -------------------------------

describe("normalizeError: Case C (error event + string error)", () => {
  it("uses the string as the user message", () => {
    const frame = taskEvent({
      taskId: "task-errstr",
      type: "error",
      error: "Failed to initialize task executor",
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.userMessage, "Failed to initialize task executor");
    assert.equal(result.errorCode, "error_string");
    assert.equal(result.rawEventType, "error");
    assert.equal(result.taskId, "task-errstr");
  });

  it("falls through to error_no_message when the string is empty/whitespace", () => {
    const frame = taskEvent({
      taskId: "task-empty-errstr",
      type: "error",
      error: "   ",
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "error_no_message");
    assert.notEqual(result.userMessage, "unknown error");
  });
});

// ---- Case D: error event + Error-like / nested message ----------------

describe("normalizeError: Case D (error event + Error-like)", () => {
  it("reads error.message when error is an object", () => {
    const frame = taskEvent({
      taskId: "task-errobj",
      type: "error",
      error: { message: "Failed to resume interrupted task: ECONNREFUSED" },
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(
      result.userMessage,
      "Failed to resume interrupted task: ECONNREFUSED",
    );
    assert.equal(result.errorCode, "error_nested");
    assert.equal(result.rawEventType, "error");
  });

  it("handles error object without a message field", () => {
    const frame = taskEvent({
      taskId: "task-errobj-empty",
      type: "error",
      error: { code: "ENOENT" }, // no message
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "error_no_message");
    assert.notEqual(result.userMessage, "unknown error");
  });
});

// ---- Case E: protocol upgrade / unknown shape -------------------------

describe("normalizeError: Case E (unrecognised shape / protocol upgrade)", () => {
  it("returns null for non-error events", () => {
    const frame: EventFrame = {
      type: "event",
      event: "task.created",
      payload: { taskId: "t1" },
    };
    assert.equal(normalizeError(frame), null);
    assert.equal(isErrorEvent(frame), false);
  });

  it("returns null for known non-error event types (execution_run_summary, etc.)", () => {
    const nonErrorTypes = [
      "execution_run_summary",
      "task_completed",
      "task_cancelled",
      "timeline_step_updated",
    ];
    for (const innerType of nonErrorTypes) {
      const frame = taskEvent({ type: innerType, taskId: "t1" });
      assert.equal(
        normalizeError(frame),
        null,
        `expected null for inner type ${innerType}`,
      );
      assert.equal(isErrorEvent(frame), false, `isErrorEvent should be false for ${innerType}`);
    }
  });

  it("returns unrecognized_shape for a new error-like inner type", () => {
    // Imagine upstream v2 introduces 'task_failed_v2' but
    // the payload still carries a `payload.message`.
    const frame = taskEvent({
      taskId: "task-v2",
      type: "task_failed_v2",
      payload: { message: "rate limit exceeded" },
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "unrecognized_shape");
    // The actual message IS recoverable; we still surface
    // it because that's strictly more useful than a
    // diagnostic. The errorCode flags it for downstream
    // routing/migration.
    assert.equal(result.userMessage, "rate limit exceeded");
    assert.equal(result.rawEventType, "task_failed_v2");
  });

  it("returns unrecognized_shape with diagnostic when no message is recoverable", () => {
    const frame = taskEvent({
      taskId: "task-v2-empty",
      type: "task_failed_v2",
      // no payload.message
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "unrecognized_shape");
    assert.notEqual(result.userMessage, "unknown error");
    assert.match(result.userMessage, /diagnostic err-/);
  });
});

// ---- Robustness / invariants ------------------------------------------

describe("normalizeError: robustness", () => {
  it("does not throw on null payload", () => {
    const frame: EventFrame = {
      type: "event",
      event: "task.event",
      payload: null,
    };
    // tsc complains but runtime must be safe.
    assert.doesNotThrow(() => normalizeError(frame));
    assert.equal(normalizeError(frame), null);
  });

  it("does not throw on missing payload", () => {
    const frame: EventFrame = {
      type: "event",
      event: "task.event",
    };
    assert.doesNotThrow(() => normalizeError(frame));
    assert.equal(normalizeError(frame), null);
  });

  it("does not throw on payload that is a string", () => {
    const frame: EventFrame = {
      type: "event",
      event: "task.event",
      // @ts-expect-error: intentionally invalid for robustness test
      payload: "not an object",
    };
    assert.doesNotThrow(() => normalizeError(frame));
    assert.equal(normalizeError(frame), null);
  });

  it("does not throw on a payload that is an array", () => {
    const frame: EventFrame = {
      type: "event",
      event: "task.event",
      // @ts-expect-error: intentionally invalid for robustness test
      payload: [1, 2, 3],
    };
    assert.doesNotThrow(() => normalizeError(frame));
    // Per codex directive (Case E: "must not swallow events;
    // must do deterministic degradation"), an array payload
    // is a malformed event but we still surface a
    // NormalizedError with `unrecognized_shape` so the user
    // and the audit trail see that something happened —
    // instead of silently dropping the event.
    const result = normalizeError(frame);
    assertWellFormed(result);
    assert.equal(result.errorCode, "unrecognized_shape");
    assert.notEqual(result.userMessage, "unknown error");
  });

  it("diagnosticId is monotonically unique per process", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const frame = taskEvent({ type: "timeline_error", payload: {} });
      const result = normalizeError(frame);
      assertWellFormed(result);
      assert.ok(
        !seen.has(result.diagnosticId),
        `diagnosticId ${result.diagnosticId} should be unique`,
      );
      seen.add(result.diagnosticId);
    }
    assert.equal(seen.size, 50);
  });

  it("all NormalizedError fields are readonly and the result does not mutate", () => {
    const frame = taskEvent({
      taskId: "task-iso",
      type: "timeline_error",
      payload: { message: "first" },
    });
    const result = normalizeError(frame);
    assertWellFormed(result);
    // Object.freeze is a strong invariant. The TS type
    // declares fields as readonly, but we also freeze the
    // object so accidental mutations are caught at runtime.
    assert.ok(Object.isFrozen(result), "NormalizedError must be frozen");
  });
});

// ---- isErrorEvent helper ---------------------------------------------

describe("isErrorEvent", () => {
  it("returns true for known error types", () => {
    assert.equal(
      isErrorEvent(taskEvent({ type: "timeline_error", payload: {} })),
      true,
    );
    assert.equal(
      isErrorEvent(taskEvent({ type: "error", error: "x" })),
      true,
    );
  });

  it("returns false for known non-error types", () => {
    assert.equal(
      isErrorEvent(taskEvent({ type: "task_completed" })),
      false,
    );
    assert.equal(
      isErrorEvent(taskEvent({ type: "execution_run_summary" })),
      false,
    );
  });

  it("returns false for non-task.event frames", () => {
    const frame: EventFrame = { type: "event", event: "task.created" };
    assert.equal(isErrorEvent(frame), false);
  });

  it("returns true for an unknown type that has an error-like shape (top-level error field)", () => {
    // v1.16.5+ (W-UI-002): the previous implementation
    // also auto-classified a frame whose nested
    // `payload.message` was a string as an error. That
    // was too broad — a plan-stage group-finished event
    // carries a nested message and is not an error. The
    // contract now is: only the top-level `error` field
    // is enough to flag an unrecognised type as an error.
    assert.equal(
      isErrorEvent(taskEvent({ type: "task_failed_v2", error: "x" })),
      true,
    );
  });

  it("returns false for an unknown type whose only error-like signal is a nested message (W-UI-002)", () => {
    // Counter-example: an unknown event type with a
    // nested message is NOT automatically an error. The
    // previous behaviour caused the "Task failed:
    // Completed DISCOVER" regression.
    assert.equal(
      isErrorEvent(
        taskEvent({ type: "task_failed_v2", payload: { message: "x" } }),
      ),
      false,
    );
  });
});
