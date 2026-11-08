import type { Attempt, ToolCall } from "../contract/execution.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { PermissionRefusalDetails, ReduceInput } from "./input.js";
import {
  cancelNow,
  clearOptional,
  emit,
  fail,
  illegal,
  ok,
  remember,
  type ReduceResult,
} from "./reduce-helpers.js";
import { requestBatchApproval } from "./reduce-batch-tooling.js";
import { failPermission } from "./reduce-permission-failure.js";
import { applyToolRejection } from "./tool-rejection.js";
import { openBatch, settleBatch } from "./tool-batch.js";
import { ticketIdFor, type ExecutionState } from "./state.js";

/**
 * The tool-shaped half of the reducer, split out of `reduce.ts` (ADR
 * `2026-09-16-ADR-循环迭代间隙开冻` §4.1) so the iteration-gap work could land
 * without making the frozen file longer.
 *
 * Two shapes of tool execution live here and they must stay distinguishable:
 *
 *  - **single** — `activeToolCallId` names the one call in flight. This is the
 *    only shape a run uses unless parallelism is explicitly opened.
 *  - **batch** — `activeToolCallIds` names every call in flight; the phase
 *    returns to `turning` only when the last of them settles. Opening a batch
 *    and never settling it is not representable: `settleBatch` is the only way
 *    out of `tooling`, and it always removes exactly one id.
 */

export function applyInvalidToolArguments(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "tool_arguments_invalid" }>,
): ReduceResult {
  const remembered = remember(state, input.eventId);
  const next: ExecutionState = {
    ...remembered,
    openToolInputIds: remembered.openToolInputIds.filter((id) => id !== input.toolCallId),
    toolCalls: {
      ...remembered.toolCalls,
      [input.toolCallId]: {
        toolCallId: input.toolCallId,
        name: input.name,
        arguments: {},
        status: "failed",
      },
    },
  };

  return ok(next, [
    emit(
      "tool_result",
      {
        toolCallId: input.toolCallId,
        status: "failed",
        code: "invalid_arguments",
        message: input.message,
      },
      input.eventId,
    ),
  ]);
}

/**
 * `batch` is supplied by the caller and is the *only* switch: with it, a tool
 * request joins the in-flight set instead of becoming the single active call.
 */
export function applyToolRequest(
  state: ExecutionState,
  input: Extract<ReduceInput, { type: "tool_request" }>,
  batch = false,
): ReduceResult {
  if (input.toolCallId.length === 0 || input.name.length === 0) {
    return fail(state, {
      code: "invalid_input",
      message: "tool_request_requires_id_and_name",
      from: state.phase,
      event: input.type,
    });
  }

  const call: ToolCall = {
    toolCallId: input.toolCallId,
    name: input.name,
    arguments: input.arguments,
    status: input.needsApproval ? "awaiting_permission" : "executing",
  };
  // A closed tool call retires its input block; the block must not stay open.
  const remembered: ExecutionState = {
    ...remember(state, input.eventId),
    openToolInputIds: state.openToolInputIds.filter((id) => id !== input.toolCallId),
  };

  if (input.needsApproval) {
    // A batch member that needs a person joins the batch and asks, but does not
    // park the whole response in `approval_waiting`: its siblings still have to
    // be registered before anything runs (`reduce-batch-tooling.ts`).
    if (batch) {
      return requestBatchApproval(remembered, input, call);
    }

    const ticketId = ticketIdFor(input.toolCallId);
    const next: ExecutionState = {
      ...remembered,
      phase: "approval_waiting",
      activeToolCallId: input.toolCallId,
      toolCalls: { ...remembered.toolCalls, [input.toolCallId]: call },
      approvals: {
        ...remembered.approvals,
        [ticketId]: { ticketId, toolCallId: input.toolCallId, status: "requested" },
      },
    };

    return ok(next, [
      emit("tool_use", { toolCallId: input.toolCallId, name: input.name }, input.eventId),
      emit("approval_requested", { ticketId, toolCallId: input.toolCallId }, `${input.eventId}:ask`),
      {
        type: "request_permission",
        toolCallId: input.toolCallId,
        ticketId,
        name: input.name,
        idempotencyKey: `perm:${input.toolCallId}`,
      },
    ]);
  }

  if (batch) {
    const next: ExecutionState = {
      ...clearOptional(remembered, ["activeToolCallId"]),
      phase: "tooling",
      activeToolCallIds: openBatch(remembered.activeToolCallIds ?? [], input.toolCallId),
      toolCalls: { ...remembered.toolCalls, [input.toolCallId]: call },
    };
    return ok(next, [
      emit("tool_use", { toolCallId: input.toolCallId, name: input.name }, input.eventId),
      { type: "execute_tool", toolCallId: input.toolCallId, idempotencyKey: `tool:${input.toolCallId}` },
    ]);
  }

  const next: ExecutionState = {
    ...remembered,
    phase: "tooling",
    activeToolCallId: input.toolCallId,
    toolCalls: { ...remembered.toolCalls, [input.toolCallId]: call },
  };

  return ok(next, [
    emit("tool_use", { toolCallId: input.toolCallId, name: input.name }, input.eventId),
    { type: "execute_tool", toolCallId: input.toolCallId, idempotencyKey: `tool:${input.toolCallId}` },
  ]);
}

/** Additive result text: replaying an older input preserves its original shape. */
export function toolSuccessPayload(input: Extract<ReduceInput, { type: "tool_succeeded" }>): JsonObject {
  return {
    value: input.value,
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
  };
}

export function resolvePermission(
  state: ExecutionState,
  eventId: string,
  expectedId: string,
  gotId: string,
  resolution: "approved" | "denied" | "expired",
  details: PermissionRefusalDetails = {},
): ReduceResult {
  if (expectedId !== gotId) {
    return fail(state, {
      code: "invalid_input",
      message: "permission_tool_mismatch",
      from: state.phase,
      event: resolution,
    });
  }

  const call = state.toolCalls[expectedId];
  if (call === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "unknown_tool_call",
      from: state.phase,
      event: resolution,
    });
  }

  const ticketId = ticketIdFor(expectedId);
  const remembered = remember(state, eventId);
  const approvals = {
    ...remembered.approvals,
    [ticketId]: {
      ticketId,
      toolCallId: expectedId,
      status: resolution === "approved" ? "approved" : resolution,
    } as const,
  };

  if (resolution === "approved") {
    const next: ExecutionState = {
      ...remembered,
      phase: "tooling",
      approvals,
      toolCalls: {
        ...remembered.toolCalls,
        [expectedId]: { ...call, status: "executing" },
      },
    };
    return ok(next, [
      { type: "execute_tool", toolCallId: expectedId, idempotencyKey: `tool:${expectedId}` },
    ]);
  }

  const next: ExecutionState = {
    ...clearOptional(remembered, ["activeToolCallId"]),
    phase: "turning",
    approvals,
    toolCalls: {
      ...remembered.toolCalls,
      [expectedId]: { ...call, status: "denied" },
    },
  };

  return ok(next, [
    emit("permission_denied", { toolCallId: expectedId, resolution, ...details }, eventId),
    emit("tool_result", { toolCallId: expectedId, status: "failed", code: details.code ?? "permission_denied",
      message: details.message ?? resolution }, `${eventId}:result`),
  ]);
}

export function applyToolOutcome(
  state: ExecutionState,
  eventId: string,
  expectedId: string,
  gotId: string,
  status: "succeeded" | "failed" | "unknown",
  payload: JsonObject,
): ReduceResult {
  if (expectedId !== gotId) {
    return fail(state, {
      code: "invalid_input",
      message: "tool_result_mismatch",
      from: state.phase,
      event: status,
    });
  }

  const call = state.toolCalls[expectedId];
  if (call === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "unknown_tool_call",
      from: state.phase,
      event: status,
    });
  }

  const remembered = remember(state, eventId);
  const attemptId = remembered.currentAttemptId;
  if (attemptId === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "missing_attempt",
      from: state.phase,
      event: status,
    });
  }

  const next: ExecutionState = {
    ...clearOptional(remembered, ["activeToolCallId"]),
    phase: "turning",
    toolCalls: {
      ...remembered.toolCalls,
      [expectedId]: { ...call, status },
    },
  };
  const kind = status === "unknown" ? "observation" : "tool_result";

  return ok(next, [
    emit(kind, { toolCallId: expectedId, status, ...payload }, eventId),
  ]);
}

/**
 * One member of a batch settling.
 *
 * The phase only returns to `turning` when the last member lands — a batch that
 * went back to `turning` on its first result would let the next request be built
 * while the others are still running, which is exactly the race this shape
 * exists to prevent (反方 #18).
 */
export function applyBatchOutcome(
  state: ExecutionState,
  eventId: string,
  ids: ReadonlyArray<string>,
  gotId: string,
  status: "succeeded" | "failed" | "unknown",
  payload: JsonObject,
): ReduceResult {
  if (!ids.includes(gotId)) {
    return fail(state, {
      code: "invalid_input",
      message: "tool_result_mismatch",
      from: state.phase,
      event: status,
    });
  }

  const call = state.toolCalls[gotId];
  if (call === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "unknown_tool_call",
      from: state.phase,
      event: status,
    });
  }

  const remembered = remember(state, eventId);
  if (remembered.currentAttemptId === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "missing_attempt",
      from: state.phase,
      event: status,
    });
  }

  const remaining = settleBatch(ids, gotId);
  const next: ExecutionState = {
    ...remaining.length === 0
      ? clearOptional(remembered, ["activeToolCallIds"])
      : { ...remembered, activeToolCallIds: remaining },
    phase: remaining.length === 0 ? "turning" : "tooling",
    toolCalls: { ...remembered.toolCalls, [gotId]: { ...call, status } },
  };
  const kind = status === "unknown" ? "observation" : "tool_result";

  return ok(next, [
    emit(kind, { toolCallId: gotId, status, ...payload }, eventId),
  ]);
}

export function reduceApproval(state: ExecutionState, input: ReduceInput): ReduceResult {
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
    case "permission_approved":
      return resolvePermission(state, input.eventId, toolCallId, input.toolCallId, "approved");
    case "permission_denied":
      return resolvePermission(state, input.eventId, toolCallId, input.toolCallId, "denied", {
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.message === undefined ? {} : { message: input.message }),
      });
    case "permission_expired":
      return resolvePermission(state, input.eventId, toolCallId, input.toolCallId, "expired");
    case "permission_failed":
      return failPermission(state, input.eventId, toolCallId, input.toolCallId, input.message);
    case "tool_rejected":
      return applyToolRejection(state, input);
    case "cancel":
      return cancelNow(state, input.eventId);
    default:
      return illegal(state, input);
  }
}

/** `attempts` is read by the batch path so a settled call can be attributed. */
export type ToolAttempt = Attempt;
