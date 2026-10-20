import type { PermissionPort } from "../../ports/permission.js";
import type { ToolPort } from "../../ports/tools.js";

/** A permission owner lends denials; this adapter cannot create an allowance.
 * Keep the static catalog: --tools + --deny-tools must reach policy denial,
 * not fail preflight as an unmounted capability. Remembered session denials
 * are separately reflected by the shared grant-cache visibility.
 */
export function restrictDeniedTools(tools: ToolPort, permission: PermissionPort): ToolPort {
  const denied = permission.isDenied;
  if (denied === undefined) return tools;
  return {
    snapshot: () => tools.snapshot(),
    async execute(call, signal) {
      if (denied(call.name)) return { outcome: "error", code: "permission_denied", message: `${call.name} is explicitly denied by the current permission policy` };
      return tools.execute(call, signal);
    },
    cancel: id => tools.cancel(id),
  };
}
