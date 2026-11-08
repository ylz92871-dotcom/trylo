import type { ExecutionError } from "../contract/error.js";
import type { Attempt, ToolCall } from "../contract/execution.js";
import type { JsonObject, TerminalReason } from "../protocol/envelope.js";
import type { EffectCommand, DomainEvent } from "./command.js";
import type { ReduceInput } from "./input.js";
import type { ExecutionState } from "./state.js";

export type ReduceOk = {
  readonly ok: true;
  readonly state: ExecutionState;
  readonly commands: readonly EffectCommand[];
  readonly events: readonly DomainEvent[];
  readonly duplicate?: true;
};

export type ReduceErr = {
  readonly ok: false;
  readonly state: ExecutionState;
  readonly error: ExecutionError;
};

export type ReduceResult = ReduceOk | ReduceErr;

export function remember(state: ExecutionState, eventId: string): ExecutionState {
  return { ...state, seenEventIds: [...state.seenEventIds, eventId] };
}

export function withPhase(state: ExecutionState, phase: ExecutionState["phase"]): ExecutionState {
  return { ...state, phase };
}

export function clearOptional(
  state: ExecutionState,
  keys: ReadonlyArray<
    "terminalReason" | "activeToolCallId" | "activeToolCallIds" | "lastError"
  >,
): ExecutionState {
  const copy: Record<string, unknown> = { ...state };
  for (const key of keys) {
    delete copy[key];
  }
  return copy as ExecutionState;
}

export function markAttemptTerminal(state: ExecutionState): readonly Attempt[] {
  return state.attempts.map((item) =>
    item.attemptId === state.currentAttemptId ? { ...item, status: "terminal" as const } : item,
  );
}

export function emit(kind: string, payload: JsonObject, idempotencyKey: string): EffectCommand {
  return { type: "emit", kind, payload, idempotencyKey };
}

export function ok(state: ExecutionState, commands: readonly EffectCommand[]): ReduceOk {
  const events = commands
    .filter((command) => command.type === "emit")
    .map((command) => ({ kind: command.kind, payload: command.payload }));
  return { ok: true, state, commands, events };
}

export function fail(state: ExecutionState, error: ExecutionError): ReduceErr {
  return { ok: false, state: { ...state, lastError: error }, error };
}

export function illegal(state: ExecutionState, input: ReduceInput): ReduceErr {
  return fail(state, {
    code: "illegal_transition",
    message: `illegal_transition:${state.phase}:${input.type}`,
    from: state.phase,
    event: input.type,
  });
}

export function terminate(
  state: ExecutionState,
  reason: TerminalReason,
  eventId: string,
  payload: JsonObject,
): ReduceResult {
  const remembered = remember(state, eventId);
  // A terminal state carries no in-flight call, single or batched: leaving ids
  // behind would let a projection report tools as still running after the turn
  // has ended (WP D 波 §5.1).
  const next: ExecutionState = {
    ...clearOptional(remembered, ["activeToolCallId", "activeToolCallIds"]),
    phase: "terminal",
    terminalReason: reason,
    attempts: markAttemptTerminal(remembered),
  };

  return ok(next, [emit("terminal", { reason, ...payload }, eventId)]);
}

export function cancelNow(state: ExecutionState, eventId: string): ReduceResult {
  const commands: EffectCommand[] = [
    emit("user_cancel", { phase: state.phase }, eventId),
    emit("terminal", { reason: "cancelled" }, `${eventId}:term`),
  ];

  if (state.phase === "streaming" || state.phase === "turning") {
    const attemptId = state.currentAttemptId;
    if (attemptId !== undefined) {
      commands.push({
        type: "cancel_provider",
        attemptId,
        idempotencyKey: `cancel-provider:${attemptId}`,
      });
    }
  }

  const inFlight: readonly string[] =
    state.activeToolCallId !== undefined
      ? [state.activeToolCallId]
      : (state.activeToolCallIds ?? []);

  if (state.phase === "tooling") {
    for (const id of inFlight) {
      commands.push({ type: "cancel_tool", toolCallId: id, idempotencyKey: `cancel-tool:${id}` });
    }
  }

  const remembered = remember(state, eventId);
  const toolCalls = inFlight.reduce<Record<string, ToolCall>>((acc, id) => {
    const call = remembered.toolCalls[id];
    if (call !== undefined) {
      acc[id] = { ...call, status: "cancelled" };
    }
    return acc;
  }, { ...remembered.toolCalls });
  const next: ExecutionState = {
    ...clearOptional({ ...remembered, toolCalls }, ["activeToolCallId", "activeToolCallIds"]),
    phase: "terminal",
    terminalReason: "cancelled",
    attempts: markAttemptTerminal(remembered),
  };

  return ok(next, commands);
}
