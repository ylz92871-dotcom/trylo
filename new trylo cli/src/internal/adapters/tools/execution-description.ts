import type { FileAccessMode, ToolBinding } from "../../ports/tools.js";
import type { ShellModeResult } from "../sandbox/shell-mode.js";
import { PATH_READ_TOOL_NAMES } from "./read-only/path-names.js";
import { DEFAULT_SHELL_TIMEOUT_MS } from "../sandbox/policy.js";
import { MAX_TIMEOUT_MS } from "./mutating/shell-timeout-policy.js";

const FILE_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "notebook_edit", ...PATH_READ_TOOL_NAMES, "run_shell"]);

/** One command-language description for the base binding and final catalog. */
export function shellToolDescription(mode?: ShellModeResult): string {
  let execution = "Execution mode: direct programs, with no shell interpreter. Shell builtins, variables, cd and redirections are unavailable. Use cwd for the working directory; pipelines and structural steps/pipeTo are supported.";
  if (mode !== undefined) {
    if (!mode.ok) execution = `Command execution is unavailable: ${mode.code}. Correct the run's shell setting; no interpreter fallback will run.`;
    else if (mode.mode.kind === "shell") execution = `Execution mode: ${mode.mode.shell.kind} shell. Write command in that interpreter's native syntax; builtins, variables, pipelines and redirections are supported. The steps and pipeTo arguments are unavailable in this mode; put the workflow in command instead.`;
  }
  return `${execution} Foreground timeout defaults to ${DEFAULT_SHELL_TIMEOUT_MS} ms (maximum ${MAX_TIMEOUT_MS} ms). For builds, test suites or other work that may outlast this, use runInBackground: true and poll write_stdin with the returned sessionId; poll the existing command instead of starting it again. cwd defaults to the workspace root; cwd and stdoutFile follow the configured target scope. stdoutFile saves exact foreground stdout only on success, excluding stderr; do not combine it with runInBackground. Foreground output is bounded and returned after completion. Only installed programs can run; no POSIX utility such as cat, grep, sed or head can be assumed available. Read and edit files with read_file, edit_file or write_file. A nonzero exit or timeout means the command failed; inspect output and possible partial effects before retrying. Tool permission is checked before execution.`;
}

/** Descriptions may vary by run; schemas and catalog identity remain unchanged. */
export function describeToolExecution(binding: ToolBinding, config: { readonly fileAccess?: FileAccessMode; readonly shellMode?: ShellModeResult }): ToolBinding {
  if (!FILE_TOOLS.has(binding.name)) return binding;
  let description = binding.description;
  if (binding.name === "run_shell") description = shellToolDescription(config.shellMode);
  if (config.fileAccess !== undefined && config.fileAccess !== "workspace") {
    description += ` Current filesystem target scope: ${config.fileAccess}; workspace-only parameter wording describes the default profile, not this run. Explicit external targets still require permission. Reviewed mode refuses local links escaping the workspace; use an explicit external target for review. Windows ACLs remain authoritative.`;
  }
  return description === binding.description ? binding : { ...binding, description };
}
