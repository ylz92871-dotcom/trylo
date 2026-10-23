import type { PermissionGrantCache } from "../loop/permission-grants.js";
import type { PermissionPort } from "../ports/permission.js";

/** A child can consult live parent decisions, including revocation, but cannot write them. */
export function inheritedGrantView(grants: PermissionGrantCache | undefined): PermissionGrantCache | undefined {
  if (grants === undefined) return undefined;
  return { lookup: action => grants.lookup(action), isDenied: name => grants.isDenied(name), entries: () => grants.entries(),
    // The child loop's cache protocol includes mutation; this borrowed view is
    // deliberately read-only. Only the parent permission owner can record grants.
    record: () => {}, revoke: () => {}, clear: () => {} };
}

/** The loop consumes cached exact-call grants first. Unapproved calls never open a new approval channel. */
export const SUBAGENT_PERMISSION: PermissionPort = {
  request: async action => ({ ticketId: `subagent-denied-${action.toolCallId}`, toolCallId: action.toolCallId }),
  awaitDecision: async () => ({ resolution: "denied", scope: "once", reason: "policy_denied" }),
};
