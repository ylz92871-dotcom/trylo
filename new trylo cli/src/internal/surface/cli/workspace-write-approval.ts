import type { PermissionAction } from "../../ports/permission.js";
import { canonicalRoot, resolveWriteTarget } from "../../adapters/tools/shared/workspace.js";
import { parseApplyPatch } from "../../adapters/tools/mutating/apply-patch-format.js";
import path from "node:path";

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

/** Automatic editing excludes security/configuration targets and destructive
 * patch operations. Those stay with the parent's ordinary approval channel. */
export function automaticWorkspaceWriteAllowed(root: string, action: PermissionAction): boolean {
  const canonicalWorkspace = canonicalRoot(root);
  const ordinary = (target: unknown): boolean => {
    if (typeof target !== "string") return false;
    const resolved = resolveWriteTarget(root, target, "workspace");
    if (!resolved.ok) return false;
    const parts = path.relative(canonicalWorkspace, resolved.absolutePath).replaceAll("\\", "/").toLowerCase().split("/");
    if (parts.some(part => part === ".." || [".git", ".ssh", ".aws", ".azure", ".kube", ".codex", ".agents"].includes(part))) return false;
    const trylo = parts.indexOf(".trylo");
    if (trylo >= 0 && parts[trylo + 1] !== "out") return false;
    return !parts.some(part => /^\.env(?:\.|$)|^(?:credentials?|secrets?)(?:[.-]|$)|\.(?:pem|key|p12|pfx)$/.test(part))
      && ![".npmrc", ".netrc", "agents.md"].includes(parts.at(-1) ?? "");
  };
  if (action.name !== "apply_patch") return ordinary(action.arguments["path"]);
  const patch = action.arguments["patch"];
  if (typeof patch !== "string") return false;
  const parsed = parseApplyPatch(patch);
  return parsed.ok && parsed.hunks.length > 0 && parsed.hunks.every(hunk => hunk.kind !== "delete"
    && ordinary(hunk.path) && (hunk.kind !== "update" || hunk.moveTo === undefined));
}
