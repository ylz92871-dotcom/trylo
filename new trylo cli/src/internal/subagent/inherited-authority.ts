import type { PermissionGrantCache } from "../loop/permission-grants.js";
import type { PermissionPort } from "../ports/permission.js";
import { decision, type PermissionDecision } from "../ports/permission.js";
import type { SandboxVerdict, ToolCallRequest, ToolSandbox } from "../ports/tools.js";

/** Refuse member scope violations before permission admission, using the
 * existing recoverable tool rejection. The dispatch boundary checks again. */
export function constrainSubagentSandbox(parent: ToolSandbox | undefined,
  constrain: (call: ToolCallRequest) => SandboxVerdict): ToolSandbox | undefined {
  if (parent === undefined) return undefined;
  return { policy: parent.policy, evaluate: call => {
    const verdict = parent.evaluate(call);
    return verdict.ok ? constrain(call) : verdict;
  }, ...(parent.requiresApproval === undefined ? {} : { requiresApproval: (call: ToolCallRequest) => parent.requiresApproval?.(call) === true }) };
}

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

/** Uses the parent's automatic policy only; it cannot open its approval channel. */
export function inheritedPermission(parent: PermissionPort): PermissionPort {
  const policy = parent.inheritance;
  if (policy === undefined) return parent.isDenied === undefined ? SUBAGENT_PERMISSION
    : { ...SUBAGENT_PERMISSION, isDenied: name => parent.isDenied?.(name) === true };
  const pending = new Map<string, PermissionDecision>();
  let sequence = 0;
  return {
    ...(parent.isDenied === undefined ? {} : { isDenied: (name: string) => parent.isDenied?.(name) === true }),
    request: async action => {
      const ticketId = `inherited-${++sequence}`;
      pending.set(ticketId, policy.decide(action));
      return { ticketId, toolCallId: action.toolCallId };
    },
    awaitDecision: async ticketId => {
      const result = pending.get(ticketId) ?? decision("denied", "once", "policy_denied");
      pending.delete(ticketId);
      return result;
    },
  };
}
