import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReduceInput } from "./input.js";
import { reduce } from "./reduce.js";
import { initialState } from "./state.js";

let n = 0;

function eid(): string {
  n += 1;
  return `evt-${n}`;
}

function start(): ReduceInput {
  return {
    type: "start_turn",
    eventId: eid(),
    sessionId: "ses-1",
    turnId: "trn-1",
    correlationId: "cor-1",
    text: "hi",
  };
}

test("duplicate eventId is idempotent", () => {
  const first = start();
  const opened = reduce(initialState(), first);

  assert.equal(opened.ok, true);

  if (!opened.ok) {
    return;
  }

  const again = reduce(opened.state, first);

  assert.equal(again.ok, true);

  if (!again.ok) {
    return;
  }

  assert.equal(again.duplicate, true);
  assert.equal(again.state.phase, opened.state.phase);
  assert.equal(again.commands.length, 0);
});

test("retry creates a new attempt and keeps correlation", () => {
  let state = initialState();

  for (const input of [
    start(),
    { type: "begin_stream", eventId: eid() } satisfies ReduceInput,
    { type: "transport_unknown", eventId: eid(), message: "lost" } satisfies ReduceInput,
  ]) {
    const result = reduce(state, input);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    state = result.state;
  }

  assert.equal(state.phase, "terminal");
  assert.equal(state.terminalReason, "unknown");
  const previous = state.currentAttemptId;
  const retried = reduce(state, { type: "retry", eventId: eid() });

  assert.equal(retried.ok, true);

  if (!retried.ok) {
    return;
  }

  assert.equal(retried.state.phase, "turning");
  assert.equal(retried.state.correlationId, "cor-1");
  assert.notEqual(retried.state.currentAttemptId, previous);
  assert.equal(retried.state.attempts.length, 2);
  assert.equal(retried.state.attempts[0]?.attemptId, previous);
  assert.equal(retried.state.attempts[0]?.status, "terminal");
});

test("completed cannot be retried", () => {
  let state = initialState();

  for (const input of [
    start(),
    { type: "begin_stream", eventId: eid() } satisfies ReduceInput,
    { type: "finish", eventId: eid() } satisfies ReduceInput,
    { type: "turn_complete", eventId: eid() } satisfies ReduceInput,
  ]) {
    const result = reduce(state, input);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    state = result.state;
  }

  const retried = reduce(state, { type: "retry", eventId: eid() });

  assert.equal(retried.ok, false);

  if (retried.ok) {
    return;
  }

  assert.equal(retried.error.code, "illegal_transition");
  assert.equal(state.phase, "terminal");
  assert.equal(state.terminalReason, "completed");
});

test("late finish after cancel does not rewrite terminal", () => {
  let state = initialState();

  for (const input of [
    start(),
    { type: "begin_stream", eventId: eid() } satisfies ReduceInput,
    { type: "cancel", eventId: eid() } satisfies ReduceInput,
  ]) {
    const result = reduce(state, input);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    state = result.state;
  }

  const late = reduce(state, { type: "finish", eventId: eid() });

  assert.equal(late.ok, true);

  if (!late.ok) {
    return;
  }

  assert.equal(late.state.phase, "terminal");
  assert.equal(late.state.terminalReason, "cancelled");
  assert.equal(late.events[0]?.kind, "observation");
});

test("completed and verification fail are independent facts", () => {
  let state = initialState();

  for (const input of [
    start(),
    { type: "begin_stream", eventId: eid() } satisfies ReduceInput,
    { type: "finish", eventId: eid() } satisfies ReduceInput,
    { type: "turn_complete", eventId: eid() } satisfies ReduceInput,
    {
      type: "check_result",
      eventId: eid(),
      checkId: "c1",
      verdict: "fail",
    } satisfies ReduceInput,
  ]) {
    const result = reduce(state, input);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    state = result.state;
  }

  assert.equal(state.phase, "terminal");
  assert.equal(state.terminalReason, "completed");
  assert.equal(state.verification.status, "fail");
  assert.notEqual(state.terminalReason, "failed");
});

test("permission deny is not user cancel", () => {
  let state = initialState();

  for (const input of [
    start(),
    { type: "begin_stream", eventId: eid() } satisfies ReduceInput,
    {
      type: "tool_request",
      eventId: eid(),
      toolCallId: "call-1",
      name: "echo",
      arguments: {},
      needsApproval: true,
    } satisfies ReduceInput,
    { type: "permission_denied", eventId: eid(), toolCallId: "call-1" } satisfies ReduceInput,
  ]) {
    const result = reduce(state, input);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    state = result.state;
  }

  assert.equal(state.phase, "turning");
  assert.equal(state.terminalReason, undefined);
  assert.equal(state.toolCalls["call-1"]?.status, "denied");
  assert.notEqual(state.terminalReason, "cancelled");
});
