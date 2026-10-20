import { statSync } from "node:fs";
import type { SandboxPolicy, ToolCallRequest } from "../../ports/tools.js";
import { APPLY_PATCH_TOOL, EDIT_FILE_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL } from "../tools/mutating/names.js";
import { readEditInput } from "../tools/mutating/edit-input.js";
import { SKILL_TOOL_NAME } from "../tools/skill/names.js";
import { resolveInsideWorkspace, resolveWriteTarget } from "../tools/shared/workspace.js";
import type { CommandShape } from "./executable.js";
import { planShell } from "./shell-plan.js";
import type { ShellModeResult } from "./shell-mode.js";

/**
 * The admission planner: one pure function that turns "a tool call" into
 * "exactly what would happen to the machine, or the reason it may not".
 *
 * It is used twice on purpose:
 *
 *  - by the sandbox before a human is asked anything, so nobody is prompted to
 *    approve something that is already out of bounds;
 *  - by the tool itself immediately before acting, so execution cannot proceed
 *    on a call that was never planned.
 *
 * Both calls are deterministic and see the same policy, which is why doing it
 * twice adds checks rather than chances to disagree. It never re-parses the
 * provider's argument *bytes* — those were parsed once, upstream, and arrive
 * here as a `JsonObject`.
 */

export type WritePlan = {
  readonly tool: "write_file";
  readonly absolutePath: string;
  readonly bytes: number;
};

export type EditPlan = {
  readonly tool: "edit_file";
  readonly absolutePath: string;
  /** Exact replacements also bound the resulting whole-file write. */
  readonly maxWriteBytes?: number;
};

/**
 * WP13 (L13): `notebook_edit` plans exactly like `edit_file` — one existing
 * regular file inside the workspace. Cell addressing is validated at execution
 * (the cells only exist after the file is read); the planner's job is the
 * containment and existence gate, nothing more.
 */
export type NotebookEditPlan = {
  readonly tool: "notebook_edit";
  readonly absolutePath: string;
};

/**
 * A multi-file patch plan stays at the call level on purpose: per-file
 * targets are only known after parsing the `patch` argument, so the planner
 * gates the mode and the argument's presence here, and execution resolves
 * every target through the same workspace resolvers before touching disk.
 */
export type ApplyPatchPlan = {
  readonly tool: "apply_patch";
};

/**
 * One command after planning, plus the platform shape it must be started with
 * (see `executable.ts`). `pipeTo` is the receiving pipeline: `A | B | C` plans
 * as a step whose `pipeTo` is itself a step with a `pipeTo`, so every segment
 * was planned alone and the chain is only as admissible as its least
 * admissible half. Spawned back to front by us and joined with pipes, never by
 * a shell.
 */
export type ShellCommand = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly shape: CommandShape;
};

export type ShellStep = ShellCommand & {
  readonly pipeTo?: ShellStep;
};

export type ShellPlan = {
  readonly tool: "run_shell";
  /** An approved workspace-relative destination for this command's stdout. */
  readonly stdoutFile?: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Always at least one: the plain `command` is step zero. */
  readonly steps: readonly ShellStep[];
  readonly shape: CommandShape;
};

export type MutationPlan = WritePlan | EditPlan | NotebookEditPlan | ApplyPatchPlan | ShellPlan | SkillPlan;

/**
 * WP14: the `skill` tool names a read the sandbox has no path opinion about —
 * it loads skill text, it touches no workspace path of its own. Its plan is the
 * argument shape, so an unplanned call can still never slip past admission.
 */
export type SkillPlan = {
  readonly tool: "skill";
};

export type MutationPlanResult =
  | { readonly ok: true; readonly plan: MutationPlan }
  | { readonly ok: false; readonly code: string; readonly message: string };

function deny(code: string, message: string): MutationPlanResult {
  return { ok: false, code, message };
}

function readTextArgument(
  call: ToolCallRequest,
  key: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: string } {
  const value = call.arguments[key];
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }
  return { ok: true, value };
}

/**
 * A tool the sandbox has no constraint for is a tool it cannot bound, so the
 * answer is refusal, not a shrug. This is what keeps `sideEffect` from being
 * only documentation: adding a tool without its plan does not quietly grant it
 * freedom.
 */
function planForMode(policy: SandboxPolicy, name: string): MutationPlanResult | undefined {
  if (!isPlannedTool(name)) {
    return deny("unknown_tool", `no sandbox constraint exists for tool ${name}`);
  }
  if (policy.mode === "deny_all") {
    return deny("sandbox_deny_all", `${name} is refused by sandbox mode deny_all`);
  }
  // `read_only` names the mutating set, not "every planned tool": a read-only
  // tool added to the planned set keeps its own plan (复核 F2) — refusing it
  // here would deny a read because it sits in a mutating list.
  if (policy.mode === "read_only" && isMutatingTool(name)) {
    return deny("sandbox_read_only", `${name} is refused by sandbox mode read_only`);
  }
  return undefined;
}

function isMutatingTool(name: string): boolean {
  return name === WRITE_FILE_TOOL || name === EDIT_FILE_TOOL || name === NOTEBOOK_EDIT_TOOL || name === APPLY_PATCH_TOOL || name === RUN_SHELL_TOOL;
}

function isPlannedTool(name: string): boolean {
  return name === WRITE_FILE_TOOL || name === EDIT_FILE_TOOL || name === NOTEBOOK_EDIT_TOOL || name === APPLY_PATCH_TOOL || name === RUN_SHELL_TOOL || name === SKILL_TOOL_NAME;
}

export function planMutation(policy: SandboxPolicy, call: ToolCallRequest, shellMode?: ShellModeResult): MutationPlanResult {
  const mode = planForMode(policy, call.name);
  if (mode !== undefined) {
    return mode;
  }
  if (call.name === SKILL_TOOL_NAME) {
    return planSkill(call);
  }
  if (call.name === WRITE_FILE_TOOL) {
    return planWrite(policy, call);
  }
  if (call.name === EDIT_FILE_TOOL) {
    return planEdit(policy, call);
  }
  if (call.name === NOTEBOOK_EDIT_TOOL) {
    return planNotebookEdit(policy, call);
  }
  if (call.name === APPLY_PATCH_TOOL) {
    return planApplyPatch(call);
  }
  return planShell(policy, call, shellMode);
}

function planSkill(call: ToolCallRequest): MutationPlanResult {
  const name = call.arguments["skill"];
  if (typeof name !== "string" || name.trim().length === 0) {
    return deny("invalid_arguments", "skill requires a non-empty skill name");
  }
  return { ok: true, plan: { tool: "skill" } };
}

function planWrite(policy: SandboxPolicy, call: ToolCallRequest): MutationPlanResult {
  const path = readTextArgument(call, "path");
  if (!path.ok) {
    return deny(path.code, "write_file requires a non-empty path");
  }
  const content = call.arguments["content"];
  if (typeof content !== "string") {
    return deny("invalid_arguments", "write_file requires content to be a string");
  }
  const verdict = resolveWriteTarget(policy.workspaceRoot, path.value, policy.fileAccess, policy.workspaceAlias);
  if (!verdict.ok) {
    return deny(verdict.code, `write_file target refused: ${verdict.code}`);
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > policy.maxWriteBytes) {
    return deny(
      "write_too_large",
      `write_file refuses ${bytes} bytes above the ${policy.maxWriteBytes} byte ceiling; it is never silently truncated`,
    );
  }
  return { ok: true, plan: { tool: "write_file", absolutePath: verdict.absolutePath, bytes } };
}

function planEdit(policy: SandboxPolicy, call: ToolCallRequest): MutationPlanResult {
  const path = readTextArgument(call, "path");
  if (!path.ok) {
    return deny(path.code, "edit_file requires a non-empty path");
  }
  const edit = readEditInput(call.arguments);
  if (edit.kind === "invalid") return deny(edit.code, edit.message);
  if (edit.kind === "replace" && Buffer.byteLength(edit.newString, "utf8") > policy.maxWriteBytes) {
    return deny("write_too_large", `edit_file replacement exceeds the ${policy.maxWriteBytes} byte ceiling`);
  }
  const verdict = resolveInsideWorkspace(policy.workspaceRoot, path.value, policy.fileAccess, policy.workspaceAlias);
  if (!verdict.ok) {
    return deny(verdict.code, `edit_file target refused: ${verdict.code}`);
  }
  try {
    if (!statSync(verdict.absolutePath).isFile()) {
      return deny("file_missing", "edit_file requires an existing regular file");
    }
  } catch {
    return deny("file_missing", "edit_file requires an existing regular file");
  }
  return { ok: true, plan: { tool: "edit_file", absolutePath: verdict.absolutePath, ...(edit.kind === "replace" ? { maxWriteBytes: policy.maxWriteBytes } : {}) } };
}

function planNotebookEdit(policy: SandboxPolicy, call: ToolCallRequest): MutationPlanResult {
  const path = readTextArgument(call, "path");
  if (!path.ok) {
    return deny(path.code, "notebook_edit requires a non-empty path");
  }
  if (!path.value.toLowerCase().endsWith(".ipynb")) {
    return deny("invalid_arguments", "notebook_edit only edits .ipynb files");
  }
  const source = call.arguments["new_source"];
  if (typeof source !== "string") {
    return deny("invalid_arguments", "notebook_edit requires new_source to be a string");
  }
  const verdict = resolveInsideWorkspace(policy.workspaceRoot, path.value, policy.fileAccess, policy.workspaceAlias);
  if (!verdict.ok) {
    return deny(verdict.code, `notebook_edit target refused: ${verdict.code}`);
  }
  try {
    if (!statSync(verdict.absolutePath).isFile()) {
      return deny("file_missing", "notebook_edit requires an existing regular file");
    }
  } catch {
    return deny("file_missing", "notebook_edit requires an existing regular file");
  }
  return { ok: true, plan: { tool: "notebook_edit", absolutePath: verdict.absolutePath } };
}

function planApplyPatch(call: ToolCallRequest): MutationPlanResult {
  const patch = readTextArgument(call, "patch");
  if (!patch.ok) {
    return deny(patch.code, "apply_patch requires a non-empty patch");
  }
  return { ok: true, plan: { tool: "apply_patch" } };
}
