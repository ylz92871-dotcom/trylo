import type { Attempt } from "../contract/execution.js";
import type { ReduceInput } from "./input.js";
import {
  cancelNow,
  clearOptional,
  emit,
  fail,
  illegal,
  markAttemptTerminal,
  ok,
  remember,
  terminate,
  type ReduceResult,
} from "./reduce-helpers.js";
import {
  MAX_ATTEMPTS,
  attemptIdFor,
  type ExecutionState,
} from "./state.js";

/**
 * The lifecycle half of the reducer, split out of `reduce.ts` (ADR
 * `2026-09-16-ADR-循环迭代间隙开冻` §4.1): turn start/end, the retry path, late
 * inputs and verification results.
 *
 * `finish` and the two turn-end inputs stay together because they are one rule
 * seen from two sides — a stream ending is not a turn ending, and keeping the
 * pair in one file is what stops someone from "simplifying" them into one.
 */

/**
 * Records a provider stream ending without deciding the turn. `finish` is one
 * stream's fact; whether the *turn* may end is decided by `turn_complete` or
 * `turn_failed`, which the turn loop issues after it has settled every tool
 * call this stream produced.
 */
export function recordFinish(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "finish" }>,
  phase: ExecutionState["phase"],
): ReduceResult {
  if (state.openToolInputIds.length > 0) {
    return terminate(state, "failed", input.eventId, {
      cause: "unsettled_tool_input",
      toolCallIds: state.openToolInputIds.join(","),
    });
  }

  const remembered = remember(state, input.eventId);

  return ok(
    {
      ...remembered,
      phase,
      finishReason: input.reason ?? "",
      requiresFollowUp: input.requiresFollowUp === true,
    },
    [
      emit(
        "stream_end",
        { reason: input.reason ?? "", requiresFollowUp: input.requiresFollowUp === true },
        input.eventId,
      ),
    ],
  );
}

/**
 * The turn loop's verdict, applied to the domain. `turn_failed` carries the
 * decision's reason so an operator can tell a budget stop from a provider stop
 * without parsing a message.
 *
 * A reason beginning with `waiting:` marks a turn that stopped because it needs
 * a person, not because it broke (WP D 波 §5.3). That distinction is carried on
 * the envelope as `awaitingContinuation` so no consumer has to read the reason
 * string to find out — the string stays for humans, the boolean is the fact.
 */
export function awaitingContinuationOf(reason: string): boolean {
  return reason.startsWith("waiting:");
}

export function applyTurnEnd(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "turn_complete" | "turn_failed" }>,
): ReduceResult {
  if (input.type === "turn_complete") {
    return terminate(state, "completed", input.eventId, {
      finishReason: state.finishReason,
      requiresFollowUp: state.requiresFollowUp,
    });
  }
  return terminate(state, "failed", input.eventId, {
    cause: input.reason,
    finishReason: state.finishReason,
    awaitingContinuation: awaitingContinuationOf(input.reason),
  });
}

/**
 * A budget stop is not a crash. The terminal envelope says so explicitly, so a
 * projection can offer "continue" instead of reporting a failure the user cannot
 * act on (反方 #22).
 */
export function applyBudgetExhausted(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "budget_exhausted" }>,
): ReduceResult {
  return terminate(state, "failed", input.eventId, {
    cause: input.reason,
    awaitingContinuation: true,
    ...(input.used === undefined ? {} : { budgetUsed: input.used }),
    ...(input.limit === undefined ? {} : { budgetLimit: input.limit }),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
  });
}

export function applyCheck(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "check_result" }>,
): ReduceResult {
  if (state.phase === "idle") {
    return illegal(state, input);
  }

  const remembered = remember(state, input.eventId);
  const next: ExecutionState = {
    ...remembered,
    verification: { status: input.verdict, checkId: input.checkId },
  };
  const kind = state.phase === "terminal" ? "observation" : "check_result";

  return ok(next, [
    emit(
      kind,
      {
        checkId: input.checkId,
        verdict: input.verdict,
        terminalReason: state.terminalReason ?? "",
      },
      input.eventId,
    ),
  ]);
}

export function applyTerminal(state: ExecutionState, input: ReduceInput): ReduceResult {
  if (input.type === "retry") {
    return applyRetry(state, input.eventId);
  }

  const remembered = remember(state, input.eventId);

  return ok(remembered, [
    emit(
      "observation",
      { late: true, ignored: input.type, terminalReason: state.terminalReason ?? "" },
      input.eventId,
    ),
  ]);
}

export function applyRetry(state: ExecutionState, eventId: string): ReduceResult {
  if (state.terminalReason !== "failed" && state.terminalReason !== "unknown") {
    return fail(state, {
      code: "illegal_transition",
      message: "retry_requires_failed_or_unknown",
      from: state.phase,
      event: "retry",
    });
  }

  const turnId = state.turnId;
  const correlationId = state.correlationId;
  const sessionId = state.sessionId;
  if (turnId === undefined || correlationId === undefined || sessionId === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "retry_missing_turn",
      from: state.phase,
      event: "retry",
    });
  }

  if (state.attempts.length >= MAX_ATTEMPTS) {
    return fail(state, {
      code: "overflow",
      message: "retry_exhausted",
      from: state.phase,
      event: "retry",
    });
  }

  const index = state.attempts.length + 1;
  const attempt: Attempt = {
    attemptId: attemptIdFor(turnId, index),
    index,
    status: "active",
  };
  const superseded = state.attempts.map((item) =>
    item.status === "active" ? { ...item, status: "superseded" as const } : item,
  );
  const remembered = remember(state, eventId);
  const next: ExecutionState = {
    ...clearOptional(remembered, ["terminalReason", "activeToolCallId", "activeToolCallIds", "lastError"]),
    phase: "turning",
    sessionId,
    turnId,
    correlationId,
    currentAttemptId: attempt.attemptId,
    streamIndex: 0,
    attempts: [...superseded, attempt],
  };

  return ok(next, [
    emit(
      "api_retry",
      { attemptId: attempt.attemptId, correlationId, previous: state.currentAttemptId ?? "" },
      eventId,
    ),
  ]);
}

export function cancelFromTooling(state: ExecutionState, eventId: string): ReduceResult {
  return cancelNow(state, eventId);
}

export function terminalAttempts(state: ExecutionState): ReadonlyArray<Attempt> {
  return markAttemptTerminal(state);
}
