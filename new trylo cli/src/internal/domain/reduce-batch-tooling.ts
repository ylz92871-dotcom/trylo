import type { ToolCall, ToolCallStatus } from "../contract/execution.js";
import type { EffectCommand } from "./command.js";
import type { PermissionRefusalDetails, ReduceInput } from "./input.js";
import {
  clearOptional,
  emit,
  fail,
  ok,
  remember,
  type ReduceResult,
} from "./reduce-helpers.js";
import { openBatch, settleBatch } from "./tool-batch.js";
import { ticketIdFor, type ExecutionState } from "./state.js";

/**
 * Batch members whose outcome is a *refusal* or a permission decision, rather
 * than a tool result.
 *
 * The reducer has two shapes of tool execution (see `reduce-tooling.ts`) and
 * each settles the refused call without granting it:
 *
 *  - **single** — the call settles and the model receives its failed result.
 *  - **batch** — one refused member is a fact about *that* member. The model is
 *    owed a visible result for it, the other members still run, and the phase
 *    only returns to `turning` when the last of them has landed. A batch that
 *    ended the turn on its first refusal would leave the remaining call IDs
 *    unsettled and the next provider request holding `tool_call`s with no
 *    `tool_result`s — the very shape `illegal_transition` / `unsettled_tool_input`
 *    used to produce on a plain four-file read.
 *
 * An unavailable permission port also settles only its call. No approval was
 * obtained, so it cannot run; other work retains its own admission boundary.
 */

/**
 * Registration of a member that needs a person first.
 *
 * It joins the batch and asks; it does not leave `tooling`. The single-call
 * shape parks in `approval_waiting` with one `activeToolCallId`, which cannot
 * express "this one is waiting while its siblings are still unregistered" — a
 * second member's `tool_request` arriving during that park would be an illegal
 * transition. `request_permission` is emitted as a command, so the loop still
 * gets to register every member of the response before it interprets any of
 * them.
 */
export function requestBatchApproval(
  remembered: ExecutionState,
  input: Extract<ReduceInput, { type: "tool_request" }>,
  call: ToolCall,
): ReduceResult {
  const ticketId = ticketIdFor(input.toolCallId);
  const next: ExecutionState = {
    ...clearOptional(remembered, ["activeToolCallId"]),
    phase: "tooling",
    activeToolCallIds: openBatch(remembered.activeToolCallIds ?? [], input.toolCallId),
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

/**
 * One permission answer, for one member.
 *
 * Approved means "run it now"; the member keeps its place in the batch until
 * its own result lands. Denied and expired mean the member is settled with a
 * visible failure, so its siblings are neither blocked nor left behind.
 */
export function applyBatchPermission(
  state: ExecutionState,
  eventId: string,
  ids: ReadonlyArray<string>,
  toolCallId: string,
  resolution: "approved" | "denied" | "expired",
  details: PermissionRefusalDetails = {},
): ReduceResult {
  const located = locateMember(state, ids, toolCallId, resolution);
  if ("ok" in located) {
    return located;
  }

  const ticketId = ticketIdFor(toolCallId);

  if (resolution === "approved") {
    const remembered = remember(state, eventId);
    const next: ExecutionState = {
      ...remembered,
      phase: "tooling",
      approvals: {
        ...remembered.approvals,
        [ticketId]: { ticketId, toolCallId, status: "approved" },
      },
      toolCalls: {
        ...remembered.toolCalls,
        [toolCallId]: { ...located.call, status: "executing" },
      },
    };

    return ok(next, [
      { type: "execute_tool", toolCallId, idempotencyKey: `tool:${toolCallId}` },
    ]);
  }

  const resolved: ExecutionState = {
    ...state,
    approvals: {
      ...state.approvals,
      [ticketId]: { ticketId, toolCallId, status: resolution },
    },
  };

  return settleRefused(resolved, eventId, ids, toolCallId, located.call, "denied", [
    emit("permission_denied", { toolCallId, resolution, ...details }, eventId),
    emit(
      "tool_result",
      { toolCallId, status: "failed", code: details.code ?? "permission_denied", message: details.message ?? resolution },
      `${eventId}:result`,
    ),
  ]);
}

/**
 * A sandbox refusal for one member: the guard fired before anyone was asked, so
 * the member is settled `denied` and the rest of the batch is untouched. The
 * refusal is reported twice on purpose, exactly as the single-call path does it
 * — journal observation, model-visible result.
 */
export function applyBatchRejection(
  state: ExecutionState,
  ids: ReadonlyArray<string>,
  input: Extract<ReduceInput, { type: "tool_rejected" }>,
): ReduceResult {
  const located = locateMember(state, ids, input.toolCallId, "tool_rejected");
  if ("ok" in located) {
    return located;
  }

  return settleRefused(state, input.eventId, ids, input.toolCallId, located.call, "denied", [
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

/**
 * A broken permission gate cannot execute this member. Settle it with its
 * failure so siblings still finish and the next model request can recover.
 */
export function failBatchPermission(
  state: ExecutionState,
  eventId: string,
  ids: ReadonlyArray<string>,
  toolCallId: string,
  message: string,
): ReduceResult {
  const located = locateMember(state, ids, toolCallId, "permission_failed");
  if ("ok" in located) {
    return located;
  }

  const ticketId = ticketIdFor(toolCallId);
  const resolved: ExecutionState = {
    ...state,
    approvals: {
      ...state.approvals,
      [ticketId]: { ticketId, toolCallId, status: "failed" },
    },
  };

  return settleRefused(resolved, eventId, ids, toolCallId, located.call, "permission_failed", [
    emit("tool_result", { code: "permission_unavailable", toolCallId, status: "failed", message }, eventId),
  ]);
}

type Located = { readonly call: ToolCall } | Extract<ReduceResult, { ok: false }>;

/** A member that is not in the declared batch is not this batch's to settle. */
function locateMember(
  state: ExecutionState,
  ids: ReadonlyArray<string>,
  toolCallId: string,
  event: string,
): Located {
  if (!ids.includes(toolCallId)) {
    return fail(state, {
      code: "invalid_input",
      message: "tool_result_mismatch",
      from: state.phase,
      event,
    });
  }

  const call = state.toolCalls[toolCallId];
  if (call === undefined) {
    return fail(state, {
      code: "invalid_input",
      message: "unknown_tool_call",
      from: state.phase,
      event,
    });
  }

  return { call };
}

/**
 * Settle one refused member out of the batch and record the commands that make
 * the refusal visible. The phase returns to `turning` only when the batch is
 * empty — the same rule `applyBatchOutcome` obeys, so a refusal cannot end an
 * iteration earlier than a result would.
 */
function settleRefused(
  state: ExecutionState,
  eventId: string,
  ids: ReadonlyArray<string>,
  toolCallId: string,
  call: ToolCall,
  status: ToolCallStatus,
  commands: ReadonlyArray<EffectCommand>,
): ReduceResult {
  const remembered = remember(state, eventId);
  const remaining = settleBatch(ids, toolCallId);
  const next: ExecutionState = {
    ...(remaining.length === 0
      ? clearOptional(remembered, ["activeToolCallIds"])
      : { ...remembered, activeToolCallIds: remaining }),
    phase: remaining.length === 0 ? "turning" : "tooling",
    toolCalls: { ...remembered.toolCalls, [toolCallId]: { ...call, status } },
  };

  return ok(next, commands);
}
