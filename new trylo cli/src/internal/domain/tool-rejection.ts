import type { ReduceInput } from "./input.js";
import {
  clearOptional,
  emit,
  fail,
  ok,
  remember,
  type ReduceResult,
} from "./reduce-helpers.js";
import type { ExecutionState } from "./state.js";

/**
 * A call the sandbox refused before it reached a human.
 *
 * It is reported to the model exactly like any other failed tool result, so the
 * model can try again with a corrected path instead of silently losing the
 * turn, while the tool call itself is marked `denied` because nothing was ever
 * executed. The turn continues: a rejection is a fact about one call, not a
 * verdict on the run.
 */
export function applyToolRejection(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "tool_rejected" }>,
): ReduceResult {
  const call = state.toolCalls[input.toolCallId];
  if (call === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "unknown_tool_call",
      from: state.phase,
      event: input.type,
    });
  }

  const remembered = remember(state, input.eventId);
  const next: ExecutionState = {
    ...clearOptional(remembered, ["activeToolCallId"]),
    phase: "turning",
    toolCalls: {
      ...remembered.toolCalls,
      [input.toolCallId]: { ...call, status: "denied" },
    },
  };

  return ok(next, [
    emit(
      "tool_result",
      {
        toolCallId: input.toolCallId,
        status: "failed",
        code: input.code,
        message: input.message,
      },
      input.eventId,
    ),
  ]);
}
