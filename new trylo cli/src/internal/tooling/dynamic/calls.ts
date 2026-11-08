import { err, ok, type Result } from "../contract/result.js";
import type { JsonObject } from "../../protocol/envelope.js";

/**
 * WP16 C83 dynamic call registry — `call_id` correlation with late/duplicate
 * rejection.
 *
 * Reused mechanics:
 * - Codex `core/tools/handlers/dynamic.rs request_dynamic_tool`: inserts a
 *   pending entry keyed by `call_id`, emits `DynamicToolCallItem{InProgress}`,
 *   awaits the responder, then records `Completed/Failed`. A vanished
 *   responder is a terminal failure, never a silent success.
 * - Codex `app-server/dynamic_tools.rs on_call_response/decode_response`:
 *   the response is validated (remote image/audio must be `data:`) before it
 *   wakes the pending call; anything else becomes a fallback response.
 *
 * This registry is transport-free: it tracks which dynamic calls are pending
 * and settles each exactly once. Time comes from the caller (`nowMs`), never
 * from an ambient clock, so tests stay deterministic.
 */

export type DynamicCallStatus = "pending" | "completed" | "failed" | "cancelled" | "expired";

export type PendingDynamicCall = {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonObject;
  readonly startedMs: number;
  readonly timeoutMs: number;
  readonly status: DynamicCallStatus;
};

export type DynamicCallFailure =
  | "duplicate_call_id"
  | "unknown_call_id"
  | "call_already_settled"
  | "tool_not_allowed"
  | "call_expired";

export type DynamicCallRegistry = {
  readonly pending: Readonly<Record<string, PendingDynamicCall>>;
};

export const EMPTY_DYNAMIC_CALLS: DynamicCallRegistry = { pending: {} };

export function registerDynamicCall(
  registry: DynamicCallRegistry,
  input: {
    readonly callId: string;
    readonly toolName: string;
    readonly args: JsonObject;
    readonly nowMs: number;
    readonly timeoutMs: number;
    readonly allowedTools: ReadonlySet<string>;
  },
): Result<{ readonly registry: DynamicCallRegistry; readonly call: PendingDynamicCall }, DynamicCallFailure> {
  if (input.callId.length === 0) {
    return err("unknown_call_id", "dynamic call refuses an empty call id");
  }

  if (registry.pending[input.callId] !== undefined) {
    return err("duplicate_call_id", `dynamic call ${input.callId} is already pending`);
  }

  if (!input.allowedTools.has(input.toolName)) {
    return err("tool_not_allowed", `dynamic tool ${input.toolName} is not exposed to this turn`);
  }

  const call: PendingDynamicCall = {
    callId: input.callId,
    toolName: input.toolName,
    args: input.args,
    startedMs: input.nowMs,
    timeoutMs: input.timeoutMs,
    status: "pending",
  };

  return ok({ registry: { pending: { ...registry.pending, [input.callId]: call } }, call });
}

function settle(
  registry: DynamicCallRegistry,
  callId: string,
  status: DynamicCallStatus,
): Result<{ readonly registry: DynamicCallRegistry; readonly call: PendingDynamicCall }, DynamicCallFailure> {
  const current = registry.pending[callId];
  if (current === undefined) {
    return err("unknown_call_id", `dynamic call ${callId} is unknown`);
  }

  if (current.status !== "pending") {
    return err("call_already_settled", `dynamic call ${callId} already settled as ${current.status}`);
  }

  const settled: PendingDynamicCall = { ...current, status };

  return ok({ registry: { pending: { ...registry.pending, [callId]: settled } }, call: settled });
}

export function completeDynamicCall(
  registry: DynamicCallRegistry,
  callId: string,
): Result<{ readonly registry: DynamicCallRegistry; readonly call: PendingDynamicCall }, DynamicCallFailure> {
  return settle(registry, callId, "completed");
}

export function failDynamicCall(
  registry: DynamicCallRegistry,
  callId: string,
): Result<{ readonly registry: DynamicCallRegistry; readonly call: PendingDynamicCall }, DynamicCallFailure> {
  return settle(registry, callId, "failed");
}

export function cancelDynamicCall(
  registry: DynamicCallRegistry,
  callId: string,
): Result<{ readonly registry: DynamicCallRegistry; readonly call: PendingDynamicCall }, DynamicCallFailure> {
  return settle(registry, callId, "cancelled");
}

/** Late responses past `timeoutMs` become `expired`, never resurrected. */
export function expireDynamicCalls(
  registry: DynamicCallRegistry,
  nowMs: number,
): { readonly registry: DynamicCallRegistry; readonly expired: ReadonlyArray<string> } {
  const expired: string[] = [];
  const pending: Record<string, PendingDynamicCall> = { ...registry.pending };

  for (const [callId, call] of Object.entries(pending)) {
    if (call.status === "pending" && nowMs - call.startedMs > call.timeoutMs) {
      pending[callId] = { ...call, status: "expired" };
      expired.push(callId);
    }
  }

  return { registry: { pending }, expired };
}
