import type { ReduceInput } from "./input.js";
import { reduce } from "./reduce.js";
import { initialState, type ExecutionState } from "./state.js";

export type ReplayResult = {
  readonly state: ExecutionState;
  readonly failedAt?: number;
};

export function replay(inputs: readonly ReduceInput[]): ReplayResult {
  let state = initialState();

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    if (input === undefined) {
      continue;
    }

    const result = reduce(state, input);
    if (!result.ok) {
      return { state: result.state, failedAt: i };
    }

    state = result.state;
  }

  return { state };
}

export function sameState(left: ExecutionState, right: ExecutionState): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function normalize(state: ExecutionState): unknown {
  return {
    phase: state.phase,
    terminalReason: state.terminalReason ?? null,
    sessionId: state.sessionId ?? null,
    turnId: state.turnId ?? null,
    correlationId: state.correlationId ?? null,
    currentAttemptId: state.currentAttemptId ?? null,
    streamIndex: state.streamIndex,
    attempts: state.attempts,
    activeToolCallId: state.activeToolCallId ?? null,
    toolCalls: state.toolCalls,
    approvals: state.approvals,
    verification: state.verification,
    seenEventIds: state.seenEventIds,
    lastDeliverySequence: state.lastDeliverySequence ?? null,
    lastError: state.lastError ?? null,
  };
}
