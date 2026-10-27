import { buildPermissionAction } from "../loop/permission-grants.js";
import type { ExecPolicyGuard } from "../loop/tool-admission.js";
import type { PermissionGrantCache } from "../loop/permission-grants.js";
import { decision, isPermissionDecision, type MemberApprovalRequester, type PermissionAction,
  type PermissionDecision, type PermissionPort } from "../ports/permission.js";
import type { SandboxVerdict, ToolCallRequest } from "../ports/tools.js";
import type { SubagentContext } from "./types.js";

export type ParentActionApproval = (action: PermissionAction, requester: MemberApprovalRequester,
  signal: AbortSignal) => Promise<PermissionDecision>;

export type SubagentApprovalScope = {
  bind(context: SubagentContext): { readonly permission: PermissionPort; readonly execPolicy?: ExecPolicyGuard };
  consume(call: ToolCallRequest): boolean;
  dispose(): void;
};

type Options = {
  readonly parent: ParentActionApproval;
  readonly permission: PermissionPort;
  readonly grants?: PermissionGrantCache | undefined;
  readonly execPolicy?: ExecPolicyGuard | undefined;
  readonly requester: (context: SubagentContext) => MemberApprovalRequester;
  readonly constrain: (call: ToolCallRequest) => SandboxVerdict;
  readonly onCancelled: () => void;
};

const MAX_APPROVED_ACTIONS = 64;

/** Root-created scope. The worker tool boundary receives only consume(). */
export function createSubagentApprovalScope(options: Options): SubagentApprovalScope {
  const permits = new Map<string, PermissionAction>();
  const pending = new Map<string, PermissionAction>();
  const cancel = new AbortController();
  let sequence = 0;
  let context: SubagentContext | undefined;
  let activeWaits = 0;
  let detach = (): void => {};
  const remember = (action: PermissionAction): void => {
    if (cancel.signal.aborted) return;
    permits.set(action.toolCallId, action);
    while (permits.size > MAX_APPROVED_ACTIONS) {
      const oldest = permits.keys().next().value;
      if (oldest === undefined) break;
      permits.delete(oldest);
    }
  };
  const denied = (action: PermissionAction): boolean => options.permission.isDenied?.(action.name) === true
    || options.grants?.lookup(action).kind === "denied";

  return {
    bind(current) {
      if (context !== undefined && context !== current) throw new Error("member_approval_scope_rebound");
      context = current;
      const abort = (): void => { cancel.abort(current.signal.reason); permits.clear(); pending.clear(); };
      if (current.signal.aborted) abort();
      else current.signal.addEventListener("abort", abort, { once: true });
      detach = () => { current.signal.removeEventListener("abort", abort); };
      const permission: PermissionPort = {
        isDenied: name => options.permission.isDenied?.(name) === true || options.grants?.isDenied(name) === true,
        request: async action => {
          const ticketId = `member-${++sequence}`;
          if (pending.size >= MAX_APPROVED_ACTIONS) throw new Error("member_approval_queue_full");
          pending.set(ticketId, buildPermissionAction(action.toolCallId, action.name, action.arguments));
          return { ticketId, toolCallId: action.toolCallId };
        },
        awaitDecision: async ticketId => {
          const action = pending.get(ticketId);
          pending.delete(ticketId);
          if (cancel.signal.aborted) return decision("cancelled");
          if (action === undefined || denied(action)) return decision("denied", "once", "policy_denied");
          const call = { name: action.name, toolCallId: action.toolCallId, arguments: action.arguments };
          if (!options.constrain(call).ok) return decision("denied", "once", "policy_denied");
          activeWaits += 1;
          if (activeWaits === 1) current.setActivity?.("idle");
          try {
            const answered = await options.parent(action, options.requester(current), cancel.signal);
            if (!isPermissionDecision(answered)) throw new Error("member_parent_decision_invalid");
            if (cancel.signal.aborted) return decision("cancelled");
            if (denied(action) || !options.constrain(call).ok) return decision("denied", "once", "policy_denied");
            if (answered.resolution === "approved" && (answered.scope === "once" || options.grants === undefined)) remember(action);
            if (answered.resolution === "cancelled") options.onCancelled();
            return answered;
          } finally {
            activeWaits -= 1;
            if (activeWaits === 0 && !cancel.signal.aborted) current.setActivity?.("working");
          }
        },
      };
      const execPolicy = options.execPolicy;
      return { permission, ...(execPolicy === undefined ? {} : { execPolicy: (call: Parameters<ExecPolicyGuard>[0]) => {
        const constrained = options.constrain(call);
        if (!constrained.ok) return { kind: "denied" as const, code: constrained.code, message: constrained.message };
        const verdict = execPolicy(call);
        if (verdict?.kind === "approved") remember(buildPermissionAction(call.toolCallId, call.name, call.arguments));
        return verdict;
      } }) };
    },
    consume(call) {
      const permit = permits.get(call.toolCallId);
      permits.delete(call.toolCallId);
      if (permit === undefined || cancel.signal.aborted) return false;
      const action = buildPermissionAction(call.toolCallId, call.name, call.arguments);
      return permit.name === action.name && permit.pattern === action.pattern && !denied(action);
    },
    dispose() { detach(); cancel.abort("member_execution_retired"); permits.clear(); pending.clear(); },
  };
}
