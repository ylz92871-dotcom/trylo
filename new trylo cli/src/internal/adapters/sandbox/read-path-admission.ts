import type { SandboxPolicy, SandboxVerdict, ToolCallRequest } from "../../ports/tools.js";
import { resolveInsideWorkspace } from "../tools/shared/workspace.js";
import { PATH_READ_TOOL_NAMES } from "../tools/read-only/path-names.js";

const PATH_READERS = new Set(PATH_READ_TOOL_NAMES);
const DIRECTORY_READERS = new Set(["list_files", "search_text", "glob_files"]);

function targetOf(call: ToolCallRequest): string {
  const value = call.arguments["path"];
  return DIRECTORY_READERS.has(call.name) && (value === undefined || value === "") ? "." : typeof value === "string" ? value : "";
}

/** Host scope admits external readers only after their extra per-call approval. */
export function readPathAdmission(policy: SandboxPolicy, call: ToolCallRequest): SandboxVerdict | undefined {
  if (!PATH_READERS.has(call.name)) return undefined;
  if (policy.mode === "deny_all") return { ok: false, code: "sandbox_deny_all", message: "read refused by sandbox mode deny_all" };
  if (policy.fileAccess === undefined || policy.fileAccess === "workspace") return undefined;
  const verdict = resolveInsideWorkspace(policy.workspaceRoot, targetOf(call), policy.fileAccess, policy.workspaceAlias);
  return verdict.ok ? { ok: true } : { ok: false, code: verdict.code, message: `read target refused: ${verdict.code}` };
}

export function needsPathApproval(policy: SandboxPolicy, call: ToolCallRequest): boolean {
  return policy.fileAccess !== undefined && policy.fileAccess !== "workspace" && PATH_READERS.has(call.name)
    && !resolveInsideWorkspace(policy.workspaceRoot, targetOf(call), "workspace", policy.workspaceAlias).ok;
}
