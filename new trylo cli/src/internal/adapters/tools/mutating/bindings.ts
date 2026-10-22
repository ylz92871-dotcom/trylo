import type { ToolBinding } from "../../../ports/tools.js";
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./shell-timeout-policy.js";
import {
  DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  DEFAULT_MAX_SHELL_OUTPUT_LINES,
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_MAX_WRITE_BYTES,
} from "../../sandbox/policy.js";
import { APPLY_PATCH_TOOL, EDIT_FILE_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL } from "./names.js";

/**
 * The smallest mutating set that is still a real tool set: create text, change
 * text, run a bounded command. All three declare `needsApproval`, because the
 * alternative — approving by default and hoping the sandbox catches it — would
 * make the sandbox the only guard, and guards belong in layers.
 *
 * Every description says what the tool cannot do. That is not decoration: the
 * description is sent to the model, and a model that knows the boundary asks
 * for fewer things that cannot be approved.
 */

const OUTPUT_LIMITS = {
  maxBytes: DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  maxLines: DEFAULT_MAX_SHELL_OUTPUT_LINES,
};

const WRITE_TIMEOUT_MS = 10_000;

export const WRITE_FILE_BINDING: ToolBinding = {
  name: WRITE_FILE_TOOL,
  description:
    "Create or overwrite a UTF-8 text file inside the workspace, creating any missing parent directories. Paths outside the workspace, links that leave it, and contents above the size ceiling are refused. For a file that should contain a program's result, run its producer with run_shell and stdoutFile so the actual stdout is saved directly; do not transcribe values or copy the input data through write_file.",
  sideEffect: "workspace_write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path of the file." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: WRITE_TIMEOUT_MS,
  outputLimits: OUTPUT_LIMITS,
};

export const EDIT_FILE_BINDING: ToolBinding = {
  name: EDIT_FILE_TOOL,
  description:
    "Edit one existing file. Prefer old_string/new_string: copy exact source text from read_file, include enough context to match exactly once, and supply different replacement text. Missing or ambiguous matches leave the file unchanged. Alternatively supply a unified diff in patch: @@\n-old line\n+new line\n, preserving indentation after each diff prefix. Send hunks in file order; merge shared context. Use one edit format per call: patch mode must omit old_string and new_string entirely, including empty placeholders; replacement mode must omit patch. *** Begin Patch belongs to apply_patch, not this tool. Surrounding BOM and line endings are preserved.",
  sideEffect: "workspace_write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path of an existing file." },
      patch: { type: "string", description: "Unified diff hunks, for example @@\n-old line\n+new line\n. One existing file; no Markdown fences or *** markers." },
      old_string: { type: "string", description: "Exact existing text, matching once. Required together with new_string when patch is omitted." },
      new_string: { type: "string", description: "Replacement text; an empty string deletes the matched text. Never combine with patch." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: WRITE_TIMEOUT_MS,
  outputLimits: OUTPUT_LIMITS,
};

export const APPLY_PATCH_BINDING: ToolBinding = {
  name: APPLY_PATCH_TOOL,
  description:
    "Apply one Codex-format patch with add, update, delete and move operations across files inside the workspace. All targets resolve inside the workspace and are approved as one call; files apply sequentially, and a later failure keeps earlier files applied while the error names exactly which files changed and which did not. There is no atomic rollback across files. A move needs at least one content chunk; a context-only chunk renames without changing bytes.",
  sideEffect: "workspace_write",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Full patch text between *** Begin Patch and *** End Patch." },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: WRITE_TIMEOUT_MS,
  outputLimits: OUTPUT_LIMITS,
};

export const RUN_SHELL_BINDING: ToolBinding = {
  name: RUN_SHELL_TOOL,
  description:
    "Run one command inside the workspace with no shell: no redirections, substitutions, shell variables or cd — but `|` pipelines are allowed with any number of segments, each planned under the same refusal rules (the exit code and stdout come from the last segment). The working directory is the workspace root unless `cwd` names a directory inside it, and output is truncated, not streamed. Composition is structural: `steps` runs further commands in order and stops at the first failure, and `pipeTo` appends one more receiving command — `steps` and `pipeTo` cannot be combined. Only programs installed on this machine can run: a command built on a shell or on a POSIX utility (`cat`, `grep`, `sed`, `head`) that does not exist here will fail. Read a file with `read_file`, change one with `edit_file` or `write_file`, and run the project's own test command (for example `npm test`) to verify work. A command that will not finish soon — a dev server, a watch task — can be started with `runInBackground: true`, which returns a sessionId to continue it with instead of a result.",
  sideEffect: "external",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to run, without redirections. `a | b | c` pipelines are allowed." },
      timeoutMs: { type: "number", minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS, description: "Optional foreground timeout in milliseconds." },
      cwd: {
        type: "string",
        description:
            "Omit cwd or use '.' to run at the workspace root. An absolute cwd identical to the workspace root is also accepted. Otherwise name an existing workspace-relative directory. Do not use the literal placeholder 'workspace'. Other absolute paths and paths leaving the workspace are refused.",
      },
        stdoutFile: { type: "string", description: "Save this foreground command or pipeline's exact UTF-8 stdout to a workspace-relative file after exit 0, excluding stderr. Use for generated JSON, CSV or reports instead of copying numbers through write_file. Print only the intended artifact to stdout. Truncated, failed or cancelled commands do not publish stdout. Cannot combine with steps or runInBackground." },
      steps: {
        type: "array",
        items: { type: "string" },
        description:
          "Extra commands run in order after `command`, each with the same refusal rules. The first non-zero exit stops the run and is the result. Output retains stdout and stderr from all executed steps under the shared output caps, with truncation reported.",
      },
      pipeTo: {
        type: "string",
        description:
          "One more receiving command appended after this command's output, as `A | B`. It extends an inline pipeline when `command` already has one.",
      },
      runInBackground: {
        type: "boolean",
        description:
          "Keep the command running after this call returns and get a sessionId instead of a result. Continue it with write_stdin, where an empty `chars` polls for output without sending anything, and end it with stop_process. One command only: a `steps` chain or a pipeline has no single output stream to hand back.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
  outputLimits: OUTPUT_LIMITS,
};

export const NOTEBOOK_EDIT_BINDING: ToolBinding = {
  name: NOTEBOOK_EDIT_TOOL,
  description:
    "Insert, replace, or delete one Jupyter notebook cell (.ipynb) inside the workspace. Replace is the default; insert needs cell_type and anchors after cell_id (or at the top without one); delete removes the addressed cell. Replacing a code cell clears its outputs and execution count. Malformed notebooks and unknown cell ids refuse with named codes and leave the file byte-identical; the write is atomic and carries a file_write fact for checkpoint rollback.",
  sideEffect: "workspace_write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path of an existing .ipynb file." },
      cell_id: { type: "string", description: "Cell id to address. Required for replace and delete; anchor for insert (inserts after it, or at the top when omitted)." },
      new_source: { type: "string", description: "New cell source to write." },
      cell_type: { type: "string", enum: ["code", "markdown", "raw"], description: "Cell type. Required for insert; on replace it changes the cell's type." },
      edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "Edit mode. Defaults to replace." },
    },
    required: ["path", "new_source"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: WRITE_TIMEOUT_MS,
  outputLimits: OUTPUT_LIMITS,
};

export const MUTATING_BINDINGS: ReadonlyArray<ToolBinding> = [
  WRITE_FILE_BINDING,
  EDIT_FILE_BINDING,
  APPLY_PATCH_BINDING,
  NOTEBOOK_EDIT_BINDING,
  RUN_SHELL_BINDING,
];

/**
 * Derived, never listed again by hand: an `--allow-writes` run may approve
 * exactly the tools that declare `workspace_write`, so a new `external` tool
 * cannot be smuggled into an approval that was meant for editing files.
 */
export const WORKSPACE_WRITE_TOOL_NAMES: ReadonlyArray<string> = MUTATING_BINDINGS.filter(
  (binding) => binding.sideEffect === "workspace_write",
).map((binding) => binding.name);

export { DEFAULT_MAX_WRITE_BYTES };
