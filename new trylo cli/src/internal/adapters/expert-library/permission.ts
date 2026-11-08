import { isPermissionDecision, permissionPattern, type PermissionAction, type PermissionPort } from "../../ports/permission.js";
import { ExpertLibraryError, type ExpertActionContext, type ExpertAuthorizationAction, type ExpertAuthorizationPort } from "../../subagent/experts/contracts.js";
import { EXPERT_APPROVAL_REVIEW_MAX_BYTES } from "../../subagent/experts/contracts.js";

export type PermissionExpertAuthorizationOptions = {
  readonly permission: PermissionPort;
  /** Trusted host must consume a one-use operation bound to this exact action.
   * Models must never supply or implement this callback. */
  readonly consumeUserAction?: (actionId: string, action: ExpertAuthorizationAction) => Promise<boolean>;
};

/** Existing PermissionPort owns every prompted approval; this adapter grants no tool authority. */
export function createPermissionExpertAuthorization(options: PermissionExpertAuthorizationOptions): ExpertAuthorizationPort {
  return {
    async authorize(action, context) {
      validateAction(action);

      if (context.signal?.aborted) return { resolution: "cancelled" };

      try {
        const permissionAction = toPermissionAction(action);

        if (context.userActionId !== undefined && options.consumeUserAction !== undefined) {
          const consumed = await options.consumeUserAction(context.userActionId, action);
          if (context.signal?.aborted) return { resolution: "cancelled" };
          if (consumed) return { resolution: "approved", receipt: `user:${context.userActionId}:${permissionAction.pattern}` };
        }

        return await requestPermission(options.permission, permissionAction, context);
      } catch (error) {
        if (context.signal?.aborted) return { resolution: "cancelled" };
        if (error instanceof ExpertLibraryError) throw error;
        throw new ExpertLibraryError("resource_unavailable", "Expert approval service is unavailable; no authorization was issued");
      }
    },
  };
}

function toPermissionAction(action: ExpertAuthorizationAction): PermissionAction {
  const name = `expert_library.${action.stage}`;
  const args = { requestId: action.requestId, stage: action.stage, fingerprint: action.fingerprint, summary: action.summary,
    ...(action.reviewJson === undefined ? {} : { reviewJson: action.reviewJson }) };
  const pattern = permissionPattern(name, args);
  return { toolCallId: `${action.requestId}:${pattern}`, name, arguments: args, pattern };
}

async function requestPermission(permission: PermissionPort, action: PermissionAction, context: ExpertActionContext): ReturnType<ExpertAuthorizationPort["authorize"]> {
  const requestContext = context.signal === undefined ? {} : { signal: context.signal };
  const ticket = await permission.request(action, requestContext);

  if (context.signal?.aborted) return { resolution: "cancelled" };

  if (ticket === null || typeof ticket !== "object" || typeof ticket.ticketId !== "string" || ticket.ticketId.length === 0 || ticket.toolCallId !== action.toolCallId) {
    throw new ExpertLibraryError("unauthorized", "Expert approval ticket does not belong to the requested action");
  }

  const decision: unknown = await permission.awaitDecision(ticket.ticketId, requestContext);

  if (context.signal?.aborted) return { resolution: "cancelled" };

  if (!isPermissionDecision(decision)) throw new ExpertLibraryError("unauthorized", "Expert approval service returned an invalid decision");

  // Even an authority's session-scoped decision is consumed only for this exact
  // request. No expert-wide or stage-wide grants are cached here.
  return decision.resolution === "approved"
    ? { resolution: "approved", receipt: `permission:${ticket.ticketId}:${action.pattern}` }
    : { resolution: decision.resolution };
}

function validateAction(action: ExpertAuthorizationAction): void {
  if (action === null || typeof action !== "object" || !["create", "retain", "edit", "archive"].includes(action.stage)
    || typeof action.requestId !== "string" || action.requestId.length === 0 || action.requestId.length > 200
    || typeof action.fingerprint !== "string" || action.fingerprint.length === 0 || action.fingerprint.length > 512
    || typeof action.summary !== "string" || action.summary.length === 0 || action.summary.length > 10000
    || action.reviewJson !== undefined && (typeof action.reviewJson !== "string" || Buffer.byteLength(action.reviewJson, "utf8") > EXPERT_APPROVAL_REVIEW_MAX_BYTES)) {
    throw new ExpertLibraryError("invalid_input", "Expert authorization action is invalid");
  }
}
