import type { PermissionAction } from "../../ports/permission.js";
import { resolveWriteTarget } from "../../adapters/tools/shared/workspace.js";
import { parseApplyPatch } from "../../adapters/tools/mutating/apply-patch-format.js";

/** --allow-writes and --ask writes delegate workspace targets only. A named
 * --allow-tools grant is a separate explicit choice and does not use this test. */
export function workspaceWriteAllowed(root: string, action: PermissionAction): boolean {
  const inside = (target: unknown): boolean => typeof target === "string" && resolveWriteTarget(root, target, "workspace").ok;
  if (action.name !== "apply_patch") return inside(action.arguments["path"]);
  const patch = action.arguments["patch"];
  if (typeof patch !== "string") return false;
  const parsed = parseApplyPatch(patch);
  return parsed.ok && parsed.hunks.length > 0 && parsed.hunks.every(hunk => inside(hunk.path)
    && (hunk.kind !== "update" || hunk.moveTo === undefined || inside(hunk.moveTo)));
}
