import type { ReduceInput } from "./input.js";
import {
  cancelNow,
  emit,
  fail,
  illegal,
  ok,
  remember,
  terminate,
  type ReduceResult,
} from "./reduce-helpers.js";
import { MAX_SEEN_EVENTS, attemptIdFor, type ExecutionState } from "./state.js";
import {
  applyBudgetExhausted,
  applyCheck,
  applyTerminal,
  applyTurnEnd,
  recordFinish,
} from "./reduce-lifecycle.js";
import {
  applyBatchPermission,
  applyBatchRejection,
  failBatchPermission,
} from "./reduce-batch-tooling.js";
import {
  applyBatchOutcome,
  applyInvalidToolArguments,
  applyToolOutcome,
  applyToolRequest,
  reduceApproval,
  toolSuccessPayload,
} from "./reduce-tooling.js";

export type { ReduceErr, ReduceOk, ReduceResult } from "./reduce-helpers.js";

/**
 * The reducer.
 *
 * Split by concern (ADR `2026-09-16-ADR-循环迭代间隙开冻` §4.1): the tool-shaped
 * half lives in `reduce-tooling.ts` and the turn lifecycle in
 * `reduce-lifecycle.ts`. What stays here is the *dispatch* — which input is
 * legal in which phase — because that table is the thing worth reading in one
 * place, and it is the only part that has to grow when the iteration gap gains a
 * new input.
 *
 * Phases are the security boundary of a turn: `streaming` may accept provider
 * facts, `tooling` may accept tool outcomes, and only `turning` — nothing in
 * flight — may accept a message from the person driving the run.
 */

export function reduce(state: ExecutionState, input: ReduceInput): ReduceResult {
  const position = input.deliverySequence;
  if (position === undefined) {
    if (state.lastDeliverySequence !== undefined) {
      return invalidDelivery(state, input);
    }
    return reduceInput(state, input);
  }

  if (!Number.isSafeInteger(position) || position < 1 || state.seenEventIds.length > 0) {
    return invalidDelivery(state, input);
  }

  const previous = state.lastDeliverySequence ?? 0;
  if (position <= previous) {
    return { ok: true, state, commands: [], events: [], duplicate: true };
  }

  if (position !== previous + 1) {
    return invalidDelivery(state, input);
  }

  const result = reduceInput(state, input);

  // Even a domain refusal consumes a delivered position. Its commands remain
  // refused, while the next cancellation or transport fact can still arrive.
  return {
    ...result,
    state: { ...result.state, seenEventIds: [], lastDeliverySequence: position },
  };
}

function invalidDelivery(state: ExecutionState, input: ReduceInput): ReduceResult {
  return fail(state, { code: "invalid_input", message: "invalid_input_delivery", event: input.type });
}

function reduceInput(state: ExecutionState, input: ReduceInput): ReduceResult {
  if (state.seenEventIds.includes(input.eventId)) {
    return { ok: true, state, commands: [], events: [], duplicate: true };
  }

  if (state.phase === "terminal") {
    return input.type === "check_result" ? applyCheck(state, input) : applyTerminal(state, input);
  }

  if (state.seenEventIds.length >= MAX_SEEN_EVENTS) {
    // The cap is per turn, not per session: a turn that emitted this many
    // events cannot settle anything further — every later input would fail the
    // same way and the turn would spin to its iteration budget. Terminate with
    // a cause instead of erroring input by input (hard-eval D7 P2-A).
    return terminate(state, "failed", input.eventId, {
      cause: "event_overflow",
      limit: MAX_SEEN_EVENTS,
    });
  }

  if (input.type === "check_result") {
    return applyCheck(state, input);
  }

  switch (state.phase) {
    case "idle":
      return reduceIdle(state, input);
    case "turning":
      return reduceTurning(state, input);
    case "streaming":
      return reduceStreaming(state, input);
    case "approval_waiting":
      return reduceApproval(state, input);
    case "tooling":
      return reduceTooling(state, input);
    default: {
      const _never: never = state.phase;
      return fail(state, {
        code: "illegal_transition",
        message: `unknown_phase:${String(_never)}`,
        event: input.type,
      });
    }
  }
}

function reduceIdle(state: ExecutionState, input: ReduceInput): ReduceResult {
  if (input.type !== "start_turn") {
    return illegal(state, input);
  }

  const next: ExecutionState = {
    phase: "turning",
    sessionId: input.sessionId,
    turnId: input.turnId,
    correlationId: input.correlationId,
    currentAttemptId: attemptIdFor(input.turnId, 1),
    streamIndex: 0,
    attempts: [{ attemptId: attemptIdFor(input.turnId, 1), index: 1, status: "active" }],
    toolCalls: {},
    approvals: {},
    verification: { status: "unset" },
    seenEventIds: [...state.seenEventIds, input.eventId],
    openToolInputIds: [],
    finishReason: "",
    requiresFollowUp: false,
  };

  return ok(next, [
    emit("turn_start", { turnId: input.turnId, text: input.text }, input.eventId),
  ]);
}

/**
 * Usage is a provider *accounting* fact, not a control fact. It is accepted in
 * any phase where a stream may be in flight or has just ended, and it never
 * changes the phase, closes a block or decides the turn. De-duplication and
 * snapshot/delta semantics belong to the aggregator, not here.
 */
function applyUsage(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "usage" }>,
): ReduceResult {
  return ok(remember(state, input.eventId), [
    emit(
      "usage",
      {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        cacheWriteTokens: input.cacheWriteTokens ?? 0,
        reasoningTokens: input.reasoningTokens ?? 0,
        totalTokens: input.totalTokens ?? input.inputTokens + input.outputTokens,
      },
      input.eventId,
    ),
  ]);
}

/**
 * A message from the person driving the run, accepted **only** here.
 *
 * `turning` is the safe boundary: no stream is open and no tool is in flight, so
 * folding new text into the next request cannot interleave with a tool result or
 * a half-received argument block. Every other phase rejects this input, which is
 * what makes "a steer is never promoted mid-tool-execution" a structural
 * guarantee rather than a promise the loop has to keep (反方 #20).
 */
function applyUserInput(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "user_input" }>,
): ReduceResult {
  if (input.text.trim().length === 0) {
    return fail(state, {
      code: "invalid_input",
      message: "user_input_requires_text",
      from: state.phase,
      event: input.type,
    });
  }
  return ok(remember(state, input.eventId), [
    emit("user_correction", { text: input.text }, input.eventId),
  ]);
}

function reduceTurning(state: ExecutionState, input: ReduceInput): ReduceResult {
  switch (input.type) {
    case "begin_stream":
      return ok(
        {
          ...remember(state, input.eventId),
          phase: "streaming",
          streamIndex: state.streamIndex + 1,
        },
        [emit("api_call", { attemptId: state.currentAttemptId ?? "" }, input.eventId)],
      );
    case "cancel":
      return cancelNow(state, input.eventId);
    case "usage":
      // A provider may report usage after the stream's tool call has already
      // settled, which puts the phase back to `turning`. Usage is pure
      // accounting: it grants nothing, ends nothing and closes no block, so
      // accepting it here is safe — dropping it would silently under-report.
      return applyUsage(state, input);
    case "user_input":
      return applyUserInput(state, input);
    case "finish":
      return recordFinish(state, input, "turning");
    case "turn_complete":
    case "turn_failed":
      return applyTurnEnd(state, input);
    case "transport_fail":
      return terminate(state, "failed", input.eventId, {
        message: input.message,
        ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
      });
    case "transport_unknown":
      return terminate(state, "unknown", input.eventId, {
        message: input.message,
        ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
      });
    case "budget_exhausted":
      return applyBudgetExhausted(state, input);
    default:
      return illegal(state, input);
  }
}

function reduceStreaming(state: ExecutionState, input: ReduceInput): ReduceResult {
  switch (input.type) {
    case "text_delta":
      return ok(remember(state, input.eventId), [
        emit("text", { text: input.text }, input.eventId),
      ]);
    case "reasoning_delta":
      return ok(remember(state, input.eventId), [
        emit("thinking", { text: input.text, redacted: input.redacted }, input.eventId),
      ]);
    case "usage":
      return applyUsage(state, input);
    case "tool_input_opened":
      return ok(
        {
          ...remember(state, input.eventId),
          openToolInputIds: [...state.openToolInputIds, input.toolCallId],
        },
        [],
      );
    case "tool_arguments_invalid":
      return applyInvalidToolArguments(state, input);
    case "provider_raw_unknown":
      // Unrecognised wire data is observable but must never fail the turn.
      return ok(remember(state, input.eventId), [
        emit("observation", { component: "provider", raw_unknown: input.wire }, input.eventId),
      ]);
    case "tool_request":
      return applyToolRequest(state, input, input.batch === true);
    case "finish":
      return recordFinish(state, input, "turning");
    case "turn_complete":
    case "turn_failed":
      return applyTurnEnd(state, input);
    case "budget_exhausted":
      return applyBudgetExhausted(state, input);
    case "transport_fail":
      return terminate(state, "failed", input.eventId, {
        message: input.message,
        ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
      });
    case "transport_unknown":
      return terminate(state, "unknown", input.eventId, {
        message: input.message,
        ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
      });
    case "cancel":
      return cancelNow(state, input.eventId);
    default:
      return illegal(state, input);
  }
}

/**
 * Two shapes of tool execution, chosen by the state rather than by a flag: a run
 * that opened a batch carries `activeToolCallIds`, everything else carries the
 * historical single `activeToolCallId`.
 */
function reduceTooling(state: ExecutionState, input: ReduceInput): ReduceResult {
  if (input.type === "usage") {
    return applyUsage(state, input);
  }

  const batch = state.activeToolCallIds;
  if (batch !== undefined) {
    switch (input.type) {
      case "tool_succeeded":
        return applyBatchOutcome(state, input.eventId, batch, input.toolCallId, "succeeded", toolSuccessPayload(input));
      case "tool_failed":
        return applyBatchOutcome(state, input.eventId, batch, input.toolCallId, "failed", {
          message: input.message,
        });
      case "tool_unknown":
        return applyBatchOutcome(state, input.eventId, batch, input.toolCallId, "unknown", {
          message: input.message,
        });
      case "tool_request":
        return applyToolRequest(state, input, true);
      // A decision about one member never decides the batch: an approved member
      // runs, a refused one is settled with a visible result, and the phase
      // still waits for the last member (`reduce-batch-tooling.ts`).
      case "permission_approved":
        return applyBatchPermission(state, input.eventId, batch, input.toolCallId, "approved");
      case "permission_denied":
        return applyBatchPermission(state, input.eventId, batch, input.toolCallId, "denied", {
          ...(input.code === undefined ? {} : { code: input.code }),
          ...(input.message === undefined ? {} : { message: input.message }),
        });
      case "permission_expired":
        return applyBatchPermission(state, input.eventId, batch, input.toolCallId, "expired");
      case "permission_failed":
        return failBatchPermission(state, input.eventId, batch, input.toolCallId, input.message);
      case "tool_rejected":
        return applyBatchRejection(state, batch, input);
      case "tool_cancelled":
      case "cancel":
        return cancelNow(state, input.eventId);
      default:
        return illegal(state, input);
    }
  }

  const toolCallId = state.activeToolCallId;
  if (toolCallId === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "missing_active_tool",
      from: state.phase,
      event: input.type,
    });
  }

  switch (input.type) {
    case "tool_succeeded":
      return applyToolOutcome(state, input.eventId, toolCallId, input.toolCallId, "succeeded", toolSuccessPayload(input));
    case "tool_failed":
      return applyToolOutcome(state, input.eventId, toolCallId, input.toolCallId, "failed", {
        message: input.message,
      });
    case "tool_unknown":
      return applyToolOutcome(state, input.eventId, toolCallId, input.toolCallId, "unknown", {
        message: input.message,
      });
    case "tool_cancelled":
      return cancelNow(state, input.eventId);
    case "cancel":
      return cancelNow(state, input.eventId);
    default:
      return illegal(state, input);
  }
}
