import type { SandboxVerdict, ToolCallRequest } from "../../ports/tools.js";
import path from "node:path";
import { canonicalRoot, resolveWriteTarget } from "../../adapters/tools/shared/workspace.js";

const OTHER_MUTATIONS = ["run_shell", "apply_patch", "notebook_edit", "write_stdin", "stop_process"];
const refuse = (): SandboxVerdict => ({ ok: false, code: "team_output_scope_denied",
  message: "Work members may write only their allowed deliverables under .trylo/out; CAD planners write construction-package.md, CAD verifiers write package-review.md or verdict.md, and read-only members cannot write." });

function mayWriteDocument(role: string, target: string): boolean {
  if (role === "worker") return true;
  const filename = path.basename(target);
  if (role === "cad-planner") return filename === "construction-package.md";
  return role === "cad-verifier" && (filename === "package-review.md" || filename === "verdict.md");
}

/** Role constraints are independent of parent grants, and physical targets
 * prevent a junction inside the output tree from redirecting a workspace write.
 */
export function constrainWorkMemberTool(role: string, workspaceRoot: string, call: ToolCallRequest): SandboxVerdict {
  if (OTHER_MUTATIONS.includes(call.name)) return refuse();
  if (call.name === "write_file" || call.name === "edit_file") {
    if (typeof call.arguments["path"] !== "string") return refuse();
    const target = resolveWriteTarget(workspaceRoot, call.arguments["path"], "workspace");
    if (!target.ok) return refuse();
    const outputRoot = path.join(canonicalRoot(workspaceRoot), ".trylo", "out");
    const relative = path.relative(outputRoot, target.absolutePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return refuse();
    if (!mayWriteDocument(role, target.absolutePath)) return refuse();
  }
  return { ok: true };
}
