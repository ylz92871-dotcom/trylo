import type { JsonObject } from "../protocol/envelope.js";
import type { ReduceInput } from "../domain/input.js";
import type { PermissionGrantCache } from "./permission-grants.js";
import type { DoomLoopTracker } from "./doom-loop.js";
import type { LoopPorts } from "./runner.js";
import {
  actionFor,
  admitToolCall,
  type ToolAdmission,
  type ToolAdmissionRequest,
} from "./tool-admission.js";

/**
 * Running permission for one tool call.
 *
 * This lives outside `runner.ts` for one reason: the runner is already at the
 * size where adding anything makes it harder to reason about, and the ordering
 * rules below are exactly the kind of thing that must be readable in one
 * screen. Everything the host has to do is passed in as a callback, so nothing
 * here needs to know how the runner keeps its state.
 *
 * The order is the design:
 *
 *   1. sandbox — something already out of bounds is never put in front of a
 *      person, because asking implies it might be allowed;
 *   2. repeat detection — a call seen this many times is no longer covered by a
 *      remembered decision;
 *   3. remembered decision — exact calls only;
 *   4. the permission port — the human, last, and only when still needed.
 */

export type ToolPermissionHost = {
  readonly emit: (kind: string, payload: JsonObject) => void;
  readonly dispatch: (input: ReduceInput) => Promise<void>;
  readonly nextEventId: () => string;
  /** Reports a refusal to the model in the same channel as any tool result. */
  readonly reportFailedResult: (toolCallId: string, name: string, text: string) => void;
};

export type ToolPermissionCall = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly grants: PermissionGrantCache;
  readonly doom: DoomLoopTracker;
};

export async function runPermissionFor(
  host: ToolPermissionHost,
  ports: LoopPorts,
  call: ToolPermissionCall,
): Promise<void> {
  const request: ToolAdmissionRequest = {
    toolCallId: call.toolCallId,
    name: call.name,
    arguments: call.arguments,
  };
  const admission = await admitToolCall(
    {
      permission: ports.permission,
      grants: call.grants,
      doom: call.doom,
      ...(ports.execPolicy === undefined ? {} : { execPolicy: ports.execPolicy }),
      ...(ports.sandbox === undefined ? {} : { sandbox: ports.sandbox }),
    },
    request,
  );
  switch (admission.kind) {
    case "sandbox_rejected":
      return refuseByGuard(host, request, "sandbox", admission.code, admission.message);
    case "policy_rejected":
      return refuseByGuard(host, request, "exec_policy", admission.code, admission.message);
    case "review_rejected":
      return refuseByReviewer(host, request, admission);
    case "failed":
      return host.dispatch({
        type: "permission_failed",
        eventId: host.nextEventId(),
        toolCallId: request.toolCallId,
        message: admission.message,
      });
    case "cancelled":
      if (admission.reason !== undefined) {
        host.emit("observation", { component: "permission", code: `permission_${admission.reason}`, reason: admission.reason, toolCallId: request.toolCallId });
      }
      return host.dispatch({ type: "cancel", eventId: host.nextEventId() });
    case "expired":
      // Reported to the model for the same reason a refusal is: a call that was
      // never answered is still a `tool_call` in the transcript, and the next
      // request must carry exactly one `tool_result` for every one of them.
      host.reportFailedResult(
        request.toolCallId,
        request.name,
        `permission_expired: ${request.name} was never answered, so it did not run`,
      );
      return host.dispatch({
        type: "permission_expired",
        eventId: host.nextEventId(),
        toolCallId: request.toolCallId,
      });
    case "denied":
      return refuse(host, request, admission);
    case "approved":
      return approve(host, request, admission.source !== "prompt");
    default: {
      const _never: never = admission;
      return _never;
    }
  }
}

/**
 * A guard refusal is reported twice on purpose: the journal records that the
 * guard fired, and the transcript records it as a failed tool result. A refusal
 * the model never hears about is a refusal it asks for again, which turns one
 * denied call into a loop. Both guards are reported the same way because honour
 * belongs to whichever guard said no, not to this module.
 */
async function refuseByGuard(
  host: ToolPermissionHost,
  request: ToolAdmissionRequest,
  component: "sandbox" | "exec_policy",
  code: string,
  message: string,
): Promise<void> {
  host.emit("observation", {
    component,
    toolCallId: request.toolCallId,
    code,
    refused: true,
  });
  host.reportFailedResult(request.toolCallId, request.name, `${code}:${message}`);
  await host.dispatch({
    type: "tool_rejected",
    eventId: host.nextEventId(),
    toolCallId: request.toolCallId,
    code,
    message,
  });
}

/**
 * A reviewer's refusal is reported like any other, and separately from the
 * guards above it, because the reason it exists is different: a sandbox or a
 * policy said no from a standing instruction, whereas this one is a judgement
 * about this call. Naming which reviewer answered is what makes a wrong refusal
 * arguable — the user can see that a machine said no and go look at why.
 */
async function refuseByReviewer(
  host: ToolPermissionHost,
  request: ToolAdmissionRequest,
  admission: Extract<ToolAdmission, { kind: "review_rejected" }>,
): Promise<void> {
  host.emit("observation", {
    component: "approval_reviewer",
    toolCallId: request.toolCallId,
    reviewer: admission.reviewer,
    decision: "denied",
    rationale: admission.rationale,
  });
  host.reportFailedResult(
    request.toolCallId,
    request.name,
    `review_denied: ${admission.reviewer} refused this call (${admission.rationale})`,
  );
  await host.dispatch({
    type: "tool_rejected",
    eventId: host.nextEventId(),
    toolCallId: request.toolCallId,
    code: "review_denied",
    message: `${admission.reviewer}: ${admission.rationale}`,
  });
}

async function refuse(
  host: ToolPermissionHost,
  request: ToolAdmissionRequest,
  admission: Extract<ToolAdmission, { kind: "denied" }>,
): Promise<void> {
  const pattern = actionFor(request).pattern;
  if (admission.reason !== undefined) {
    host.emit("observation", { component: "permission", code: `permission_${admission.reason}`, reason: admission.reason, toolCallId: request.toolCallId });
  }
  if (admission.source === "remembered") {
    host.emit("observation", {
      component: "permission_grant",
      decision: "denied",
      toolCallId: request.toolCallId,
      pattern,
    });
  }
  // Same rule as a sandbox refusal, and for the same reason: a refusal the model
  // never hears about is a refusal it asks for again. It is also what lets one
  // member of a batch be refused while its siblings still run — the transcript
  // owes every `tool_call` in the assistant message one `tool_result`.
  host.reportFailedResult(
    request.toolCallId,
    request.name,
    `permission_denied: ${request.name} did not run${admission.reason === undefined ? "" : ` (${admission.reason})`}`,
  );
  await host.dispatch({
    type: "permission_denied",
    eventId: host.nextEventId(),
    toolCallId: request.toolCallId,
  });
}

async function approve(
  host: ToolPermissionHost,
  request: ToolAdmissionRequest,
  settledWithoutAsking: boolean,
): Promise<void> {
  // Both a remembered grant and a written-down policy let a call through without
  // a human being asked right now, and both are worth seeing in the journal:
  // they are the two ways something ran that nobody was looking at.
  if (settledWithoutAsking) {
    host.emit("observation", {
      component: "permission_grant",
      decision: "approved",
      toolCallId: request.toolCallId,
      pattern: actionFor(request).pattern,
    });
  }
  await host.dispatch({
    type: "permission_approved",
    eventId: host.nextEventId(),
    toolCallId: request.toolCallId,
  });
}
