import {
  isPermissionAction,
  isPermissionDecision,
  permissionPattern,
  type PermissionAction,
  type PermissionPort,
  type PermissionScope,
  type PermissionResolution,
  type PermissionReason,
  type PermissionTicket,
} from "../ports/permission.js";
import { buildPermissionAction } from "./permission-grants.js";

export type PermissionBoundaryResult =
  | {
      readonly outcome: "decided";
      readonly resolution: PermissionResolution;
      readonly scope: PermissionScope;
      readonly reason?: PermissionReason;
    }
  | {
      readonly outcome: "failed";
      readonly stage: "request" | "decision";
      readonly message: string;
    };

/**
 * The permission boundary.
 *
 * Every request goes through here so two things cannot be skipped: an action
 * that does not carry the arguments it was decided on is rejected before a
 * human is asked anything (a name-only action would approve every argument
 * value at once), and a ticket must belong to the call that asked for it.
 */
export async function awaitPermissionDecision(
  permission: PermissionPort,
  action: PermissionAction,
): Promise<PermissionBoundaryResult> {
  if (!isPermissionAction(action)) {
    return {
      outcome: "failed",
      stage: "request",
      message: "request_failed:permission_action_missing_arguments",
    };
  }
  if (action.pattern !== permissionPattern(action.name, action.arguments)) {
    return boundaryFailure("request", new Error("permission_action_fingerprint_mismatch"));
  }
  const snapshot = buildPermissionAction(action.toolCallId, action.name, action.arguments);
  let ticket: PermissionTicket;
  try {
    ticket = await permission.request(snapshot);
  } catch (err) {
    return boundaryFailure("request", err);
  }
  if (ticket === null || typeof ticket !== "object" || typeof ticket.ticketId !== "string" || ticket.ticketId.length === 0 || ticket.toolCallId !== snapshot.toolCallId) {
    return boundaryFailure("request", new Error("permission_ticket_tool_mismatch"));
  }
  try {
    const answered = await permission.awaitDecision(ticket.ticketId);
    if (!isPermissionDecision(answered)) return boundaryFailure("decision", new Error("invalid_permission_decision"));
    return {
      outcome: "decided",
      resolution: answered.resolution,
      scope: answered.scope,
      ...(answered.reason === undefined ? {} : { reason: answered.reason }),
    };
  } catch (err) {
    return boundaryFailure("decision", err);
  }
}

function boundaryFailure(
  stage: "request" | "decision",
  err: unknown,
): PermissionBoundaryResult {
  const detail = err instanceof Error ? err.message : "permission_error";
  return { outcome: "failed", stage, message: `${stage}_failed:${detail}` };
}
