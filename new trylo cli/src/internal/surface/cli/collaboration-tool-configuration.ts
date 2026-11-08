import { isPermissionDecision, permissionPattern, type PermissionPort } from "../../ports/permission.js";
import type { createProjectToolSelection } from "../../adapters/settings-tool-selection.js";
import type { ToolLibraryContext, LibraryResult } from "../../tooling/library/index.js";

/** Configuration changes use original Permission; selecting a name confers no execution authority. */
export async function configureBusinessTools(options: { readonly permission: PermissionPort; readonly signal?: AbortSignal;
  readonly selection: ReturnType<typeof createProjectToolSelection> }, context: ToolLibraryContext, names: readonly string[]): Promise<LibraryResult<void>> {
  const failure = (code: string, message: string) => ({ ok: false as const, code, message });

  if (context.memberId !== "personal_agent") return failure("frozen_team_configuration_editor_required",
    "Edit this member's tools through the original Team Composer profile; the running frozen roster is immutable");

  if (options.signal?.aborted) return failure("cancelled", "Tool configuration was cancelled");

  const args = { scope: context.scope, memberId: context.memberId, businessToolNames: [...names] };
  const name = "tool_library.configure", pattern = permissionPattern(name, args);
  const action = { toolCallId: `tool-configuration:${pattern}`, name, arguments: args, pattern };
  const requestContext = options.signal === undefined ? {} : { signal: options.signal };

  try {
    const ticket = await options.permission.request(action, requestContext);

    if (options.signal?.aborted) return failure("cancelled", "Tool configuration was cancelled");

    if (ticket?.toolCallId !== action.toolCallId || !ticket.ticketId) return failure("configuration_approval_invalid", "The approval ticket does not match this configuration");

    const decision: unknown = await options.permission.awaitDecision(ticket.ticketId, requestContext);

    if (options.signal?.aborted) return failure("cancelled", "Tool configuration was cancelled");

    if (!isPermissionDecision(decision) || decision.resolution !== "approved") return failure("configuration_not_approved", "The original permission owner did not approve this exact business tool selection");

    return options.selection.write(names);
  } catch { return failure("configuration_approval_unavailable", "The original configuration approval service is unavailable; no selection was saved"); }
}
