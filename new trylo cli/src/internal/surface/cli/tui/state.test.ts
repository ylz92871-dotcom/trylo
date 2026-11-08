import assert from "node:assert/strict";
import { test } from "node:test";
import type { CliStreamEvent } from "../../../protocol/cli-stream.js";
import {
  emptyTuiState,
  MAX_TOOL_OUTPUT_LINES,
  pushSystemLine,
  pushUserLine,
  reduceTuiEvent,
  type TuiFacts,
} from "./state.js";

/**
 * Contract #1 support: the state half of the frame is a pure reducer over the
 * existing surface events. These cases pin the event-to-state mapping the
 * status bar and the frame are allowed to show.
 */

const FACTS: TuiFacts = {
  sessionId: "repl-1",
  providerId: "fixture",
  model: "default",
  maxIterations: 8,
  contextTokenLimit: undefined,
};

function runStart(): CliStreamEvent {
  return { type: "run_start", sessionId: "repl-1", turnId: "turn-1", providerId: "fixture", model: "default" };
}

function runResult(iterations: number): CliStreamEvent {
  return {
    type: "run_result",
    status: "completed",
    finishReason: "stop",
    sessionId: "repl-1",
    turnId: "turn-1",
    iterations,
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    durationMs: 5,
    lastMessage: "done",
  };
}

test("run_start opens the running phase and clears per-turn state", () => {
  const state = reduceTuiEvent(
    reduceTuiEvent(emptyTuiState(FACTS), runResult(2)),
    runStart(),
  );

  assert.equal(state.running, true);
  assert.equal(state.iterations, 2);
  assert.equal(state.lastStatus, undefined);
  assert.equal(state.toolsInFlight.size, 0);
});

test("a streamed message becomes assistant lines only at message_end", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), { type: "message_start" });

  assert.equal(state.lines.length, 0);
  state = reduceTuiEvent(state, { type: "message_delta", text: "Hel" });
  state = reduceTuiEvent(state, { type: "message_delta", text: "lo\nworld" });
  assert.equal(state.lines.length, 0);
  state = reduceTuiEvent(state, { type: "message_end" });
  assert.deepEqual(
    state.lines.map((line) => line.text),
    ["Hello", "world"],
  );
  assert.equal(state.pending, undefined);
});

test("an empty message leaves no line behind", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), { type: "message_start" });
  state = reduceTuiEvent(state, { type: "message_end" });
  assert.equal(state.lines.length, 0);
});

test("tool_use opens an in-flight call and tool_result closes it", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_use",
    toolCallId: "call-1",
    name: "read_file",
  });

  assert.deepEqual(state.toolsInFlight.get("call-1"), { name: "read_file", input: undefined });
  state = reduceTuiEvent(state, {
    type: "tool_result",
    toolCallId: "call-1",
    status: "denied",
    output: "",
    truncated: false,
  });
  assert.equal(state.toolsInFlight.size, 0);
  // No call id: two adjacent lines are paired by being adjacent, and the id is
  // a machine handle that costs columns and says nothing to a person.
  assert.deepEqual(
    state.lines.map((line) => line.text),
    ["-> read_file", "<- denied"],
  );
});

test("a truncated tool result says so, and still quotes what came back", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_result",
    toolCallId: "call-1",
    status: "result",
    output: "x",
    truncated: true,
  });
  assert.deepEqual(
    state.lines.map((line) => line.text),
    ["<- result (truncated)", "   x"],
  );
});

test("a failed tool quotes the reason, not just the status", () => {
  const state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_result",
    toolCallId: "call-1",
    status: "error",
    output: "",
    truncated: false,
    message: "shell_nonzero_exit: npm test exited 1",
  });

  assert.deepEqual(
    state.lines.map((line) => line.text),
    ["<- error", "   ! shell_nonzero_exit: npm test exited 1"],
  );
  assert.equal(state.lines[1]?.tone, "warning", "a failure is not rendered as ordinary output");
});

test("a long output is folded and the hidden rest is counted", () => {
  const state = reduceTuiEvent(emptyTuiState(FACTS), {
    type: "tool_result",
    toolCallId: "call-1",
    status: "ok",
    output: "a\nb\nc\nd\ne\nf\ng",
    truncated: false,
  });
  const texts = state.lines.map((line) => line.text);

  assert.deepEqual(texts.at(-1), "   ... 2 more lines");
  assert.equal(texts.length, MAX_TOOL_OUTPUT_LINES + 2);
});

test("warnings render with or without a message", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), { type: "warning", code: "c1", message: "" });
  state = reduceTuiEvent(state, { type: "warning", code: "c2", message: "detail" });
  assert.deepEqual(
    state.lines.map((line) => line.text),
    ["warning c1", "warning c2: detail"],
  );
});

test("run_result closes the turn and carries iterations, status and usage", () => {
  let state = reduceTuiEvent(emptyTuiState(FACTS), runStart());

  state = reduceTuiEvent(state, {
    type: "tool_use",
    toolCallId: "call-1",
    name: "read_file",
  });
  state = reduceTuiEvent(state, runResult(2));
  assert.equal(state.running, false);
  assert.equal(state.iterations, 2);
  assert.equal(state.lastStatus, "completed");
  assert.equal(state.toolsInFlight.size, 0);
  assert.deepEqual(state.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
});

test("the reducer is pure: the input state is never mutated", () => {
  const before = emptyTuiState(FACTS);
  const opened = reduceTuiEvent(before, { type: "message_start" });
  const delta = reduceTuiEvent(opened, { type: "message_delta", text: "x" });
  const after = reduceTuiEvent(delta, { type: "message_end" });
  assert.equal(before.lines.length, 0);
  assert.equal(after.lines.length, 1);
});

test("user and system lines join the transcript in order", () => {
  let state = pushUserLine(emptyTuiState(FACTS), "hi");
  state = pushSystemLine(state, "note");
  assert.deepEqual(
    state.lines.map((line) => line.tone),
    ["user", "system"],
  );
});
