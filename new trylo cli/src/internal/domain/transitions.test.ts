import assert from "node:assert/strict";
import { test } from "node:test";
import type { InputType, ReduceInput } from "./input.js";
import { reduce } from "./reduce.js";
import { initialState, type ExecutionState, type PhaseName } from "./state.js";

let n = 0;

function eid(): string {
  n += 1;
  return `mx-${n}`;
}

const allTypes: readonly InputType[] = [
  "start_turn",
  "begin_stream",
  "text_delta",
  "usage",
  "tool_request",
  "finish",
  "turn_complete",
  "turn_failed",
  "transport_fail",
  "transport_unknown",
  "cancel",
  "permission_approved",
  "permission_denied",
  "permission_expired",
  "permission_failed",
  "tool_succeeded",
  "tool_failed",
  "tool_unknown",
  "retry",
  "check_result",
];

function sample(type: InputType): ReduceInput {
  const eventId = eid();
  switch (type) {
    case "start_turn":
      return {
        type,
        eventId,
        sessionId: "ses-1",
        turnId: "trn-1",
        correlationId: "cor-1",
        text: "hi",
      };
    case "begin_stream":
    case "finish":
    case "turn_complete":
    case "cancel":
    case "retry":
      return { type, eventId };
    case "turn_failed":
      return { type, eventId, reason: "provider_error" };
    case "text_delta":
      return { type, eventId, text: "x" };
    case "usage":
      return { type, eventId, inputTokens: 1, outputTokens: 1 };
    case "tool_request":
      return {
        type,
        eventId,
        toolCallId: "call-1",
        name: "echo",
        arguments: {},
        needsApproval: true,
      };
    case "transport_fail":
    case "transport_unknown":
      return { type, eventId, message: "x" };
    case "permission_approved":
    case "permission_denied":
    case "permission_expired":
      return { type, eventId, toolCallId: "call-1" };
    case "permission_failed":
      return { type, eventId, toolCallId: "call-1", message: "permission unavailable" };
    case "tool_succeeded":
      return { type, eventId, toolCallId: "call-1", value: { ok: true } };
    case "tool_failed":
    case "tool_unknown":
      return { type, eventId, toolCallId: "call-1", message: "x" };
    case "reasoning_delta":
      return { type, eventId, text: "thinking", redacted: false };
    case "tool_input_opened":
      return { type, eventId, toolCallId: "call-1" };
    case "tool_arguments_invalid":
      return { type, eventId, toolCallId: "call-1", name: "echo", message: "invalid_arguments" };
    case "tool_rejected":
      return { type, eventId, toolCallId: "call-1", code: "sandbox_deny_all", message: "refused" };
    case "provider_raw_unknown":
      return { type, eventId, wire: "unknown.wire.event" };
    case "budget_exhausted":
      return { type, eventId, reason: "iterations_exhausted" };
    case "tool_cancelled":
      return { type, eventId, toolCallId: "call-1" };
    case "user_input":
      return { type, eventId, text: "actually, do it differently", mode: "steer" };
    case "check_result":
      return { type, eventId, checkId: "c1", verdict: "fail" };
    default: {
      const _never: never = type;
      throw new Error(String(_never));
    }
  }
}

function drive(inputs: readonly ReduceInput[]): ExecutionState {
  let state = initialState();

  for (const input of inputs) {
    const result = reduce(state, input);
    assert.equal(result.ok, true, `${state.phase} <- ${input.type}`);
    if (!result.ok) {
      return state;
    }
    state = result.state;
  }

  return state;
}

const legal: Readonly<Record<PhaseName, ReadonlySet<InputType>>> = {
  idle: new Set(["start_turn"]),
  turning: new Set([
    "begin_stream",
    "usage",
    "finish",
    "turn_complete",
    "turn_failed",
    "cancel",
    "transport_fail",
    "transport_unknown",
    "check_result",
  ]),
  streaming: new Set([
    "text_delta",
    "usage",
    "tool_request",
    "finish",
    "turn_complete",
    "turn_failed",
    "transport_fail",
    "transport_unknown",
    "cancel",
    "check_result",
  ]),
  approval_waiting: new Set([
    "permission_approved",
    "permission_denied",
    "permission_expired",
    "permission_failed",
    "cancel",
    "check_result",
  ]),
  tooling: new Set(["tool_succeeded", "tool_failed", "tool_unknown", "usage", "cancel", "check_result"]),
  terminal: new Set(["check_result"]),
};

function stateAt(phase: PhaseName): ExecutionState {
  switch (phase) {
    case "idle":
      return initialState();
    case "turning":
      return drive([sample("start_turn")]);
    case "streaming":
      return drive([sample("start_turn"), sample("begin_stream")]);
    case "approval_waiting":
      return drive([
        sample("start_turn"),
        sample("begin_stream"),
        sample("tool_request"),
      ]);
    case "tooling":
      return drive([
        sample("start_turn"),
        sample("begin_stream"),
        {
          type: "tool_request",
          eventId: eid(),
          toolCallId: "call-1",
          name: "echo",
          arguments: {},
          needsApproval: false,
        },
      ]);
    case "terminal":
      // `finish` closes the stream; the turn loop's verdict closes the turn.
      return drive([
        sample("start_turn"),
        sample("begin_stream"),
        sample("finish"),
        sample("turn_complete"),
      ]);
    default: {
      const _never: never = phase;
      throw new Error(String(_never));
    }
  }
}

const phases: readonly PhaseName[] = [
  "idle",
  "turning",
  "streaming",
  "approval_waiting",
  "tooling",
  "terminal",
];

test("legal and illegal transitions are enumerated", () => {
  const rows: string[] = [];

  for (const phase of phases) {
    const state = stateAt(phase);

    assert.equal(state.phase, phase);

    for (const type of allTypes) {
      const result = reduce(state, sample(type));
      const allowed = legal[phase].has(type);
      const late = phase === "terminal" && type !== "retry" && type !== "check_result";
      const retryOk =
        phase === "terminal" &&
        type === "retry" &&
        (state.terminalReason === "failed" || state.terminalReason === "unknown");
      if (allowed || late || retryOk) {
        assert.equal(result.ok, true, `${phase} + ${type} should accept`);
        rows.push(`${phase}|${type}|accept`);
      } else {
        assert.equal(result.ok, false, `${phase} + ${type} should reject`);
        if (!result.ok) {
          assert.equal(result.state.phase, phase);
        }
        rows.push(`${phase}|${type}|reject`);
      }
    }
  }

  assert.equal(rows.length, phases.length * allTypes.length);
});

test("retry from completed is illegal; retry from unknown is legal", () => {
  const completed = stateAt("terminal");
  const denied = reduce(completed, sample("retry"));

  assert.equal(denied.ok, false);
  const unknown = drive([
    sample("start_turn"),
    sample("begin_stream"),
    sample("transport_unknown"),
  ]);

  assert.equal(unknown.terminalReason, "unknown");
  const allowed = reduce(unknown, sample("retry"));

  assert.equal(allowed.ok, true);
});
