import type { SandboxVerdict, ToolCallRequest, ToolSandbox } from "../../ports/tools.js";
import type { SandboxPolicy } from "../../ports/tools.js";
import { planMutation } from "./planner.js";
import type { WorkspaceSandboxConfig } from "./policy.js";
import { createSandboxPolicy } from "./policy.js";
import { needsPathApproval, readPathAdmission } from "./read-path-admission.js";

/**
 * The execution sandbox.
 *
 * It answers exactly one question — whether this call may be put in front of a
 * human at all — and nothing else. It performs no I/O beyond resolving paths,
 * grants nothing, and never executes: it is the gate in front of both approval
 * and execution, not a participant in either.
 *
 * Workspace containment is the default. Explicit reviewed/host target scopes
 * still pass through the same permission service and execution validation;
 * neither chooses the OS process boundary or grants a call permission.
 */
export function createWorkspaceSandbox(config: WorkspaceSandboxConfig): ToolSandbox {
  const policy: SandboxPolicy = createSandboxPolicy(config);
  const shellMode = config.shellMode;
  return {
    policy,
    ...(policy.mode !== "deny_all" && (config.fileAccess === undefined || config.fileAccess === "workspace") ? {}
      : { requiresApproval: (call: ToolCallRequest) => policy.mode === "deny_all" || needsPathApproval(policy, call) }),
    evaluate(call: ToolCallRequest): SandboxVerdict {
      const read = readPathAdmission(policy, call);
      if (read !== undefined) return read;
      const planned = planMutation(policy, call, shellMode);
      if (planned.ok) {
        return { ok: true };
      }
      return { ok: false, code: planned.code, message: planned.message };
    },
  };
}
