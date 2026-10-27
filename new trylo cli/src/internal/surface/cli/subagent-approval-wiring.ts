import { awaitPermissionDecision } from "../../loop/permission-boundary.js";
import { buildPermissionAction, type PermissionGrantCache } from "../../loop/permission-grants.js";
import { decision, type PermissionPort } from "../../ports/permission.js";
import type { ParentActionApproval } from "../../subagent/parent-approval.js";
import { scopedToolCallId } from "../../subagent/scoped-tool-calls.js";

/** The same root permission port and exact-call cache own every decision. */
export function parentActionApproval(permission: PermissionPort, grants?: PermissionGrantCache): ParentActionApproval {
  return async (action, requester, signal) => {
    if (signal.aborted) return decision("cancelled");
    const scoped = buildPermissionAction(scopedToolCallId(`subagent:${requester.executionId}`, action.toolCallId), action.name, action.arguments);
    const result = await awaitPermissionDecision(permission, scoped, { signal, requester });
    if (result.outcome === "failed") throw new Error(result.message);
    if (signal.aborted) return decision("cancelled");
    grants?.record(action, result.resolution, result.scope);
    return decision(result.resolution, result.scope, result.reason);
  };
}
