import { buildPermissionAction } from "../loop/permission-grants.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../ports/tools.js";
import type { SubagentLineage, SubagentPermissions } from "./types.js";

/**
 * Lineage & permission enforcement for subAgents.
 *
 * Implements strict non-amplification and provenance tracking:
 * 1. Subagent permissions strictly inherit from parent (subset only, no widening).
 * 2. Subagent NEVER gets an independent approval channel (cannot prompt user for approval).
 * 3. Pre-approved grants can only be consumed if present in parent's inheritedGrants.
 * 4. All subagent actions and envelopes are attributed to rootAttemptId.
 * 5. Rejects any attempt by subagent output to masquerade as user input/feedback.
 */

export class SubagentPermissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SubagentPermissionError";
    this.code = code;
  }
}

export class SubagentLineageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SubagentLineageError";
    this.code = code;
  }
}

/**
 * Validates that a SubagentLineage is well-formed and rooted.
 */
export function validateSubagentLineage(lineage: SubagentLineage): void {
  if (!lineage.parentAgentId || lineage.parentAgentId.trim().length === 0) {
    throw new SubagentLineageError("invalid_lineage", "subagent must have a non-empty parentAgentId");
  }
  if (!lineage.rootAttemptId || lineage.rootAttemptId.trim().length === 0) {
    throw new SubagentLineageError("invalid_lineage", "subagent must be attributed to a non-empty rootAttemptId");
  }
}

/**
 * Creates a bounded ToolPort for a subagent that strictly enforces inherited permissions.
 *
 * `runSignal` is the subagent run's own cancellation. The boundary reads it on
 * every dispatch and forwards it to the real tool port, so "no new tool
 * dispatch after a cancel" does not depend on the worker cooperating — a worker
 * that ignores its abort signal still cannot reach a tool (WP-CLI-N3).
 */
export function createSubagentToolBoundary(
  parentTools: ToolPort,
  permissions: SubagentPermissions,
  lineage: SubagentLineage,
  runSignal: AbortSignal,
  localTools?: ToolPort,
): ToolPort {
  validateSubagentLineage(lineage);
  const allowedSet = new Set(permissions.allowedTools);
  const activePorts = new Map<string, ToolPort>();

  return {
    snapshot(): ReadonlyArray<ToolBinding> {
      const parentBindings = parentTools.snapshot();
      return parentBindings.filter((binding) => allowedSet.has(binding.name) && !permissions.inheritedDenial?.(binding.name));
    },

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      // Any dispatch attempt spends its exact-call proof, including a refusal.
      const approvedAction = permissions.approvedAction?.consume(call) === true;
      // 1. Cancellation is checked before anything else. A tool reached under an
      //    already-aborted signal is an effect nobody can take back, and the run
      //    is over, so the call is refused rather than evaluated: `cancelled` is
      //    a state, not a failure to report to the model.
      if (signal.aborted || runSignal.aborted) {
        return { outcome: "cancelled" };
      }

      // 2. Tool whitelist check (non-amplification)
      if (!allowedSet.has(call.name)) {
        return {
          outcome: "error",
          code: "subagent_permission_denied",
          message: `Subagent permission denied: tool '${call.name}' is not in allowedTools [${Array.from(allowedSet).join(", ")}]`,
        };
      }

      if (permissions.inheritedDenial?.(call.name)) {
        return { outcome: "error", code: "subagent_permission_denied", message: `The parent has disabled tool '${call.name}'` };
      }
      const constrained = permissions.constrainTool?.(call);
      if (constrained && !constrained.ok) {
        return { outcome: "error", code: constrained.code, message: constrained.message };
      }

      // Check parent binding
      const binding = parentTools.snapshot().find((b) => b.name === call.name);
      if (binding === undefined) {
        return {
          outcome: "error",
          code: "tool_not_found",
          message: `Tool '${call.name}' is not available in parent tool catalog`,
        };
      }

      // 3. Approval check: Subagents NEVER have an independent approval channel!
      if (binding.needsApproval || permissions.requiresApproval?.(call) === true) {
        const action = buildPermissionAction(call.toolCallId, call.name, call.arguments);
        const hasPreApprovedGrant =
          permissions.inheritedGrants !== undefined &&
          permissions.inheritedGrants.lookup(action).kind === "approved";
        const denied = permissions.inheritedGrants?.isDenied(call.name) === true
          || permissions.inheritedGrants?.lookup(action).kind === "denied";
        const automatic = !denied && permissions.inheritedPolicy?.canUseTool(call.name) === true
          && permissions.inheritedPolicy.decide(action).resolution === "approved";
        if (denied || (!hasPreApprovedGrant && !automatic && !approvedAction)) {
          // RED LINE: Refuse immediately. Subagents cannot request independent user approval.
          return {
            outcome: "error",
            code: permissions.approvedAction === undefined ? "subagent_approval_channel_forbidden" : "subagent_parent_approval_required",
            message: permissions.approvedAction === undefined
              ? `Subagent approval channel forbidden: tool '${call.name}' requires user approval, but subagents cannot prompt users and no inherited grant exists for pattern '${action.pattern}'`
              : "Parent approval for this exact action is missing, consumed or revoked; no action was executed",
          };
        }
      }

      let executionTools = parentTools;
      const localBinding = localTools?.snapshot().find(candidate => candidate.name === call.name);
      if (localTools !== undefined && localBinding !== undefined) {
        if (binding.sideEffect !== "read_only" || binding.needsApproval
          || localBinding.sideEffect !== "read_only" || localBinding.needsApproval) {
          return { outcome: "error", code: "subagent_local_tool_invalid",
            message: "Task-local tools may replace only existing record tools without effects or approval requirements" };
        }
        executionTools = localTools;
      }
      activePorts.set(call.toolCallId, executionTools);
      try { return await dispatchUnderRunCancel(executionTools, call, signal, runSignal); }
      finally { activePorts.delete(call.toolCallId); }
    },

    async cancel(toolCallId: string): Promise<void> {
      await activePorts.get(toolCallId)?.cancel(toolCallId);
    },
  };
}

/** What a dispatched call has to say for itself. */
type DispatchAnswer =
  | { readonly kind: "outcome"; readonly outcome: ToolOutcome }
  | { readonly kind: "threw"; readonly error: unknown };

/**
 * Sends one admitted call and reports only what is provable.
 *
 * The run's cancellation must reach the tool, so the call is dispatched under a
 * signal that fires on either the caller's abort or the run's. When the run is
 * cancelled mid-flight the existing `ToolPort.cancel` path is asked to stop it:
 * a tool that answers *through* that path produced a real outcome, while a tool
 * that never answers leaves whether its side effect landed unknown — reported
 * as `unknown`, never as success and never as a clean cancellation.
 */
async function dispatchUnderRunCancel(
  parentTools: ToolPort,
  call: ToolCallRequest,
  callerSignal: AbortSignal,
  runSignal: AbortSignal,
): Promise<ToolOutcome> {
  const link = linkSignals([callerSignal, runSignal]);
  const settlement: Promise<DispatchAnswer> = parentTools.execute(call, link.signal).then(
    (outcome) => ({ kind: "outcome", outcome }),
    (error: unknown) => ({ kind: "threw", error }),
  );
  const cancelWatch = watchAbort(runSignal);

  try {
    const first: DispatchAnswer | { readonly kind: "cancelled" } = await Promise.race([
      settlement,
      cancelWatch.aborted.then(() => ({ kind: "cancelled" as const })),
    ]);

    if (first.kind === "threw") {
      throw first.error;
    }
    if (first.kind === "outcome") {
      return first.outcome;
    }

    // The run was cancelled while the call was in flight. Let the tool's own
    // cancel path speak first — its answer is the truth…
    const acknowledged: Promise<{ readonly kind: "unknown" }> = parentTools
      .cancel(call.toolCallId)
      .then(
        () => ({ kind: "unknown" as const }),
        () => ({ kind: "unknown" as const }),
      );
    const answer = await Promise.race([settlement, acknowledged]);
    if (answer.kind === "threw") {
      throw answer.error;
    }
    if (answer.kind === "outcome") {
      return answer.outcome;
    }

    // …and a cancel path that acknowledges without a result leaves the side
    // effect unknown. A failed `cancel` call reaches this same branch: it
    // confirms nothing, which is exactly what "unknown" states. (A tool whose
    // `cancel` never settles is a tool that cannot be stopped at all; the
    // subagent then keeps its governance slot until it returns — see the
    // concurrency note on `SubagentRuntime`.)
    return {
      outcome: "unknown",
      code: "call_cancelled_outcome_unknown",
      message: `Tool call '${call.name}' (${call.toolCallId}) was cancelled while in flight; whether its side effect landed is unknown`,
    };
  } finally {
    cancelWatch.stop();
    link.stop();
  }
}

/**
 * One signal that fires when any of `signals` does.
 *
 * The caller's abort and the run's are different events — the child engine can
 * stop one tool while the run continues, and the run can be cancelled while a
 * tool is in flight — and the tool has to see both. `stop()` detaches every
 * listener, so a long-lived run does not accumulate one per call.
 */
function linkSignals(signals: ReadonlyArray<AbortSignal>): {
  readonly signal: AbortSignal;
  readonly stop: () => void;
} {
  const controller = new AbortController();
  const attached: AbortSignal[] = [];
  const forward = (): void => {
    controller.abort();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      forward();
      continue;
    }
    signal.addEventListener("abort", forward, { once: true });
    attached.push(signal);
  }
  return {
    signal: controller.signal,
    stop: () => {
      for (const signal of attached) {
        signal.removeEventListener("abort", forward);
      }
    },
  };
}

/**
 * Resolves the moment `signal` aborts. `stop()` detaches the listener when the
 * call settles first, so the watch does not outlive the call it guards.
 */
function watchAbort(signal: AbortSignal): {
  readonly aborted: Promise<void>;
  readonly stop: () => void;
} {
  if (signal.aborted) {
    return { aborted: Promise.resolve(), stop: () => {} };
  }
  let resolveAborted: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  const onAbort = (): void => {
    resolveAborted();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    aborted,
    stop: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Validates that an event emitted on behalf of a subagent does not attempt to masquerade as user feedback.
 */
export function guardSubagentAttribution(
  kind: string,
  payload: Record<string, unknown>,
  lineage: SubagentLineage,
): { readonly kind: string; readonly rootAttemptId: string } {
  validateSubagentLineage(lineage);

  // Subagents cannot emit user events or masquerade as human operator
  const forbiddenUserKinds = ["user_cancel", "user_correction", "user_reject"];
  if (forbiddenUserKinds.includes(kind)) {
    throw new SubagentLineageError(
      "subagent_masquerade_blocked",
      `Subagent cannot emit user event '${kind}': subagent output must not masquerade as user feedback`,
    );
  }

  // If payload attempts to claim user origin or user input role
  if (payload.role === "user" || payload.origin === "user" || payload.source === "user") {
    throw new SubagentLineageError(
      "subagent_masquerade_blocked",
      "Subagent payload cannot claim user origin: subagent logs must attribute to subAgent, not user",
    );
  }

  return {
    kind,
    rootAttemptId: lineage.rootAttemptId,
  };
}
