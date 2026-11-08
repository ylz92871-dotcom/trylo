import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReduceInput } from "../domain/input.js";
import { reduce } from "../domain/reduce.js";
import { replay, sameState } from "../domain/replay.js";
import { initialState } from "../domain/state.js";
import { createExecutionJournal, parseJournal, serializeJournal } from "./journal.js";

test("journal delivery deduplicates old tool requests after a long stream and replays", () => {
  const journal = createExecutionJournal();
  let state = initialState();
  const apply = (input: ReduceInput) => {
    const delivered = journal.recordInput(input);
    const result = reduce(state, delivered);
    assert.equal(result.ok, true);
    state = result.state;
    return result;
  };

  apply({ type: "start_turn", eventId: "start", sessionId: "s", turnId: "t", correlationId: "c", text: "go" });
  apply({ type: "begin_stream", eventId: "stream" });
  const call: ReduceInput = { type: "tool_request", eventId: "call", toolCallId: "c1", name: "echo", arguments: {}, needsApproval: false };
  const first = apply(call);

  assert.ok(first.ok && first.commands.some(c => c.type === "execute_tool"));
  apply({ type: "tool_succeeded", eventId: "result", toolCallId: "c1", value: {} });
  apply({ type: "begin_stream", eventId: "next-stream" });

  for (let i = 0; i < 5000; i++) apply({ type: "text_delta", eventId: `text-${i}`, text: "x" });

  const duplicate = apply(call);

  assert.ok(duplicate.ok && duplicate.duplicate);
  assert.equal(duplicate.ok && duplicate.commands.length, 0);
  assert.equal(state.seenEventIds.length, 0);
  apply({ type: "finish", eventId: "finish" });
  apply({ type: "turn_complete", eventId: "complete" });
  const restored = replay(parseJournal(serializeJournal(journal.snapshot())).inputs);

  assert.equal(restored.failedAt, undefined);
  assert.equal(sameState(restored.state, state), true);
});

test("delivery positions reject gaps, invalid numbers, and unsequenced mixing", () => {
  const start: ReduceInput = { type: "start_turn", eventId: "s", deliverySequence: 1, sessionId: "s", turnId: "t", correlationId: "c", text: "go" };
  const opened = reduce(initialState(), start);

  assert.equal(opened.ok, true);

  for (const sequence of [0, -1, 1.5, NaN, Infinity, 3, undefined]) {
    const result = reduce(opened.state, { type: "begin_stream", eventId: "bad", ...(sequence === undefined ? {} : { deliverySequence: sequence }) });
    assert.equal(result.ok, false, `accepted ${String(sequence)}`);
  }
});

test("a refused domain input consumes its delivery position without blocking cancellation", () => {
  let state = initialState();
  const journal = createExecutionJournal();

  for (const input of [
    { type: "start_turn", eventId: "s", sessionId: "s", turnId: "t", correlationId: "c", text: "go" },
    { type: "tool_succeeded", eventId: "illegal", toolCallId: "absent", value: {} },
    { type: "cancel", eventId: "cancel" },
  ] satisfies ReduceInput[]) {
    const result = reduce(state, journal.recordInput(input));
    assert.equal(result.ok, input.type !== "tool_succeeded");
    state = result.state;
  }

  assert.equal(state.terminalReason, "cancelled");
});
