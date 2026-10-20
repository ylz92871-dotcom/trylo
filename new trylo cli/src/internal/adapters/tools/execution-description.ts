import type { FileAccessMode, ToolBinding } from "../../ports/tools.js";
import type { ShellModeResult } from "../sandbox/shell-mode.js";
import { PATH_READ_TOOL_NAMES } from "./read-only/path-names.js";

const FILE_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "notebook_edit", ...PATH_READ_TOOL_NAMES, "run_shell"]);

/** Descriptions may vary by run; schemas and catalog identity remain unchanged. */
export function describeToolExecution(binding: ToolBinding, config: { readonly fileAccess?: FileAccessMode; readonly shellMode?: ShellModeResult }): ToolBinding {
  if (!FILE_TOOLS.has(binding.name)) return binding;
  let description = binding.description;
  if (binding.name === "run_shell" && config.shellMode !== undefined) {
    if (!config.shellMode.ok) description = `Command execution is unavailable: ${config.shellMode.message}. No interpreter fallback will run.`;
    else if (config.shellMode.mode.kind === "shell") {
      const shell = config.shellMode.mode.shell;
      description = `Run one command string in ${shell.kind} (${shell.path}). The command accepts this interpreter's native variables, redirections and pipelines; the default direct-mode parameter restrictions do not apply. Use command alone, without steps or pipeTo. cwd defaults to the workspace root; cwd and stdoutFile follow the configured target scope. stdoutFile saves exact foreground stdout only on success, excluding stderr; do not combine it with runInBackground. Long-running commands may use runInBackground and then the process session tools. Tool permission is checked before execution.`;
    }
  }
  if (config.fileAccess !== undefined && config.fileAccess !== "workspace") {
    description += ` Current filesystem target scope: ${config.fileAccess}; workspace-only parameter wording describes the default profile, not this run. Explicit external targets still require permission. Reviewed mode refuses local links escaping the workspace; use an explicit external target for review. Windows ACLs remain authoritative.`;
  }
  return description === binding.description ? binding : { ...binding, description };
}
