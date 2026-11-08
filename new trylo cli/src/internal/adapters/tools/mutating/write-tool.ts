import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import type { MutationPlan, WritePlan } from "../../sandbox/planner.js";
import { writeFileAtomicallySync, type WriteQueue } from "./atomic-write.js";
import { renderPreview } from "./apply-patch-preview.js";

/**
 * `write_file`.
 *
 * The write itself is a whole-file replace, so the destination never holds a
 * partially written frame even if two calls collide. Size was already checked by
 * the plan; checking it again here would be theatre, but writing through the
 * queue is not: it is what keeps two writers to one path from interleaving.
 */

export type WriteRunnerConfig = {
  readonly writeQueue: WriteQueue;
};

export async function executeWriteFile(
  config: WriteRunnerConfig,
  request: ToolCallRequest,
  plan: MutationPlan,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (plan.tool !== "write_file") {
    return { outcome: "error", code: "invalid_arguments", message: "write_file received a foreign plan" };
  }

  if (signal.aborted) {
    return { outcome: "cancelled" };
  }

  const content = request.arguments["content"];
  if (typeof content !== "string") {
    return { outcome: "error", code: "invalid_arguments", message: "write_file requires content" };
  }

  const requestedPath = String(request.arguments["path"] ?? "");

  return config.writeQueue.exclusive(plan.absolutePath, async () => writePlannedFile(plan, content, requestedPath, signal));
}

function writePlannedFile(plan: WritePlan, content: string, requestedPath: string, signal: AbortSignal): ToolOutcome {
  if (signal.aborted) return { outcome: "cancelled" };

  const reportedPath = plan.absolutePath.slice(plan.absolutePath.length - requestedPath.length) === requestedPath ? plan.absolutePath : requestedPath;

  try {
    // The plan proved the target hangs inside the workspace; the parent chain
    // may still be missing, and creating it here is what makes a nested
    // write_file succeed instead of demanding a separate mkdir step.
    mkdirSync(path.dirname(plan.absolutePath), { recursive: true });
    const written = writeFileAtomicallySync(plan.absolutePath, content);
    const value = {
      fileWrite: {
        kind: "file_write" as const,
        path: requestedPath,
        bytes: written.bytes,
        mode: written.mode,
      },
      path: requestedPath,
      resolvedPath: reportedPath,
      bytes: written.bytes,
      mode: written.mode,
      // A created file's whole content is its own diff; an overwrite keeps
      // no before image here, so it carries no preview (the turn tracker
      // lists it instead of inventing one).
      ...(written.mode === "created"
        ? { preview: renderPreview({ kind: "added", path: requestedPath, before: "", after: content, regions: [] }) }
        : {}),
    };

    return {
      outcome: "result",
      value,
      output: `wrote ${requestedPath} (${written.bytes} bytes, ${written.mode})`,
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
