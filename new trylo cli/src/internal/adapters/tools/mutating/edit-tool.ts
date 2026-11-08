import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import type { EditPlan, MutationPlan } from "../../sandbox/planner.js";
import { writeFileAtomicallySync, readFileUtf8, type WriteQueue } from "./atomic-write.js";
import { applyPatch, parseUnifiedPatch, prepareSource } from "./patch-engine.js";
import { readEditInput, replaceExactText, type EditInput } from "./edit-input.js";
import type { JsonObject } from "../../../protocol/envelope.js";

type AppliedEdit =
  | { readonly ok: true; readonly content: string; readonly facts: JsonObject; readonly summary: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

function editContent(raw: string, input: Exclude<EditInput, { kind: "invalid" }>): AppliedEdit {
  if (input.kind === "replace") {
    const result = replaceExactText(raw, input.oldString, input.newString);
    return result.ok ? { ...result, facts: { replacementsApplied: 1 }, summary: "1 exact match" } : result;
  }

  const parsed = parseUnifiedPatch(input.patch);
  if (!parsed.ok) return parsed;

  const result = applyPatch(prepareSource(raw), parsed.hunks);

  return result.ok ? { ...result, facts: { hunksApplied: result.hunksApplied }, summary: `${result.hunksApplied} hunks` } : result;
}

/**
 * `edit_file`.
 *
 * The new content is computed in full *before* anything touches the disk, so a
 * hunk that will not match cannot leave a prefix of itself behind: either the
 * file is byte-identical to how it started, or every hunk landed. "Partially
 * applied and reported success" is the one outcome this must never produce.
 */

export type EditRunnerConfig = {
  readonly writeQueue: WriteQueue;
};

export async function executeEditFile(
  config: EditRunnerConfig,
  request: ToolCallRequest,
  plan: MutationPlan,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (plan.tool !== "edit_file") {
    return { outcome: "error", code: "invalid_arguments", message: "edit_file received a foreign plan" };
  }

  if (signal.aborted) {
    return { outcome: "cancelled" };
  }

  const input = readEditInput(request.arguments);
  if (input.kind === "invalid") return { outcome: "error", code: input.code, message: input.message };

  // Own the read-compare-write transaction, not only its final rename. Other
  // edits must read the preceding commit; queued cancellation must not commit.
  return config.writeQueue.exclusive(plan.absolutePath, async () => applyPlannedEdit(request, plan, input, signal));
}

function applyPlannedEdit(request: ToolCallRequest, plan: EditPlan, input: Exclude<EditInput, { kind: "invalid" }>, signal: AbortSignal): ToolOutcome {
  if (signal.aborted) return { outcome: "cancelled" };

  const requestedPath = String(request.arguments["path"] ?? "");
  let source;

  try {
    source = readFileUtf8(plan.absolutePath);
  } catch (err) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = err instanceof Error ? err.message : "read_error";
    return { outcome: "error", code: "read_failed", message: `read_failed:${detail}` };
  }

  const applied = editContent(source, input);
  if (!applied.ok) {
    return { outcome: "error", code: applied.code, message: applied.message };
  }

  if (plan.maxWriteBytes !== undefined && Buffer.byteLength(applied.content, "utf8") > plan.maxWriteBytes) {
    return { outcome: "error", code: "write_too_large", message: `edit_file result exceeds the ${plan.maxWriteBytes} byte ceiling; no file was changed` };
  }

  try {
    const written = writeFileAtomicallySync(plan.absolutePath, applied.content);
    const value = {
      fileWrite: {
        kind: "file_write" as const,
        path: requestedPath,
        bytes: written.bytes,
        mode: "patched" as const,
      },
      path: requestedPath,
      bytes: written.bytes,
      mode: "patched" as const,
      ...applied.facts,
    };

    return {
      outcome: "result",
      value,
      output: `patched ${requestedPath} (${applied.summary}, ${written.bytes} bytes)`,
      truncated: false,
    };
  } catch (err) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = err instanceof Error ? err.message : "write_error";
    return { outcome: "error", code: "write_failed", message: `write_failed:${detail}` };
  }
}
