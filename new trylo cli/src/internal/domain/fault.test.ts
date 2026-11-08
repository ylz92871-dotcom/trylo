import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReduceInput } from "./input.js";
import { reduce } from "./reduce.js";
import { MAX_ATTEMPTS, initialState } from "./state.js";

let n = 0;

function eid(): string {
  n += 1;
  return `f-${n}`;
}

function drive(inputs: readonly ReduceInput[]) {
  let state = initialState();

  for (const input of inputs) {
    const result = reduce(state, input);
    assert.equal(result.ok, true, `${state.phase} <- ${input.type}`);
    if (!result.ok) {
      return { state, last: result };
    }
    state = result.state;
  }

  return { state, last: undefined };
}

test("cancel during approval waiting is cancelled not denied", () => {
  const { state } = drive([
    {
      type: "start_turn",
      eventId: eid(),
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      text: "x",
    },
    { type: "begin_stream", eventId: eid() },
    {
      type: "tool_request",
      eventId: eid(),
      toolCallId: "call-1",
      name: "echo",
      arguments: {},
      needsApproval: true,
    },
    { type: "cancel", eventId: eid() },
  ]);

  assert.equal(state.phase, "terminal");
  assert.equal(state.terminalReason, "cancelled");
  assert.notEqual(state.toolCalls["call-1"]?.status, "denied");
});

test("cancel during tooling is cancelled not tool failure", () => {
  const { state } = drive([
    {
      type: "start_turn",
      eventId: eid(),
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      text: "x",
    },
    { type: "begin_stream", eventId: eid() },
    {
      type: "tool_request",
      eventId: eid(),
      toolCallId: "call-1",
      name: "echo",
      arguments: {},
      needsApproval: false,
    },
    { type: "cancel", eventId: eid() },
  ]);

  assert.equal(state.terminalReason, "cancelled");
  assert.equal(state.toolCalls["call-1"]?.status, "cancelled");
});

test("duplicate chunk with same eventId is ignored", () => {
  const start: ReduceInput = {
    type: "start_turn",
    eventId: eid(),
    sessionId: "s",
    turnId: "t",
    correlationId: "c",
    text: "x",
  };
  const opened = reduce(initialState(), start);

  assert.equal(opened.ok, true);

  if (!opened.ok) {
    return;
  }

  const begun = reduce(opened.state, { type: "begin_stream", eventId: eid() });

  assert.equal(begun.ok, true);

  if (!begun.ok) {
    return;
  }

  const chunk: ReduceInput = { type: "text_delta", eventId: "dup-chunk", text: "a" };
  const first = reduce(begun.state, chunk);

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  const second = reduce(first.state, chunk);

  assert.equal(second.ok, true);

  if (!second.ok) {
    return;
  }

  assert.equal(second.duplicate, true);
  assert.equal(second.commands.length, 0);
});

test("finish then cancel does not rewrite completed", () => {
  const { state } = drive([
    {
      type: "start_turn",
      eventId: eid(),
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      text: "x",
    },
    { type: "begin_stream", eventId: eid() },
    { type: "finish", eventId: eid() },
    // `finish` only closes the stream; the turn loop closes the turn.
    { type: "turn_complete", eventId: eid() },
  ]);
  const late = reduce(state, { type: "cancel", eventId: eid() });

  assert.equal(late.ok, true);

  if (!late.ok) {
    return;
  }

  assert.equal(late.state.terminalReason, "completed");
  assert.equal(late.events[0]?.kind, "observation");
});

test("duplicate tool result with new eventId is illegal after leaving tooling", () => {
  const { state } = drive([
    {
      type: "start_turn",
      eventId: eid(),
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      text: "x",
    },
    { type: "begin_stream", eventId: eid() },
    {
      type: "tool_request",
      eventId: eid(),
      toolCallId: "call-1",
      name: "echo",
      arguments: {},
      needsApproval: false,
    },
    { type: "tool_succeeded", eventId: eid(), toolCallId: "call-1", value: { ok: true } },
  ]);

  assert.equal(state.phase, "turning");
  const dup = reduce(state, {
    type: "tool_succeeded",
    eventId: eid(),
    toolCallId: "call-1",
    value: { ok: true },
  });

  assert.equal(dup.ok, false);
});

test("retry exhausts after MAX_ATTEMPTS", () => {
  let state = initialState();
  const start: ReduceInput = {
    type: "start_turn",
    eventId: eid(),
    sessionId: "s",
    turnId: "t",
    correlationId: "c",
    text: "x",
  };
  const opened = reduce(state, start);

  assert.equal(opened.ok, true);

  if (!opened.ok) {
    return;
  }

  state = opened.state;

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const begun = reduce(state, { type: "begin_stream", eventId: eid() });

    assert.equal(begun.ok, true);

    if (!begun.ok) {
      return;
    }

    const failed = reduce(begun.state, {
      type: "transport_unknown",
      eventId: eid(),
      message: "lost",
    });

    assert.equal(failed.ok, true);

    if (!failed.ok) {
      return;
    }

    state = failed.state;

    if (i < MAX_ATTEMPTS - 1) {
      const retried = reduce(state, { type: "retry", eventId: eid() });
      assert.equal(retried.ok, true);
      if (!retried.ok) {
        return;
      }
      state = retried.state;
    }
  }

  const overflow = reduce(state, { type: "retry", eventId: eid() });

  assert.equal(overflow.ok, false);

  if (overflow.ok) {
    return;
  }

  assert.equal(overflow.error.code, "overflow");
  assert.equal(state.attempts.length, MAX_ATTEMPTS);
});
