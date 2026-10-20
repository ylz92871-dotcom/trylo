import type { SandboxPolicy, ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";
import type { MutationPlan } from "../../sandbox/planner.js";
import { resolveInsideWorkspace, resolveWriteTarget } from "../shared/workspace.js";
import { APPLY_PATCH_TOOL } from "./names.js";
import { parseApplyPatch, type ApplyPatchHunk } from "./apply-patch-format.js";
import {
  abortOutcome,
  commitAdd,
  commitDelete,
  commitUpdate,
  summarizeLines,
  type AppliedAccumulator,
  type AppliedFileChange,
  type ApplyPatchConfig,
  type ApplyPatchTarget,
} from "./apply-patch-commit.js";

/**
 * `apply_patch`: one Codex-format patch, many files, sequential commits.
 *
 * Orchestration only — filesystem commits live in `apply-patch-commit.ts`.
 * The shape mirrors Codex `apply_patch` (`lib.rs` `apply_hunks_to_files`):
 * parse everything, resolve every target, then commit hunk by hunk so a
 * later failure keeps earlier files applied and says so explicitly
 * (`AppliedPatchDelta` / `ApplyPatchFailure` become the `applied` list plus
 * an error naming applied and pending paths). Three hardening deltas vs the
 * Rust original, all recorded in the WP10 construction record:
 *
 * - paths are workspace-relative only; absolute patch paths are refused by
 *   the same resolvers that bound `write_file`/`edit_file`;
 * - line endings are preserved per line and no trailing newline is forced,
 *   i.e. the `edit_file` convention, not Codex `NormalizeToLf`;
 * - each file commits read-compare-write under queue exclusivity, the
 *   single-call equivalent of the old `FileEditTool` read-version check
 *   (cross-call read tracking has no owner in this package and stays a
 *   documented residual for the session/checkpoint owners).
 *
 * Cancellation granularity is one hunk: an abort stops further commits and
 * reports `cancelled`, never success. Committed files stay committed as
 * whole files — writes are atomic renames — and the turn's
 * checkpoint-before-write snapshot is the way back.
 */

function fail(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

/** Every target resolves before anything is read or written (WP10.3). */
function resolveAll(
  policy: SandboxPolicy,
  hunks: ReadonlyArray<ApplyPatchHunk>,
): { readonly ok: true; readonly targets: ApplyPatchTarget[] } | { readonly ok: false; readonly code: string; readonly message: string } {
  const targets: ApplyPatchTarget[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === "add") {
      const verdict = resolveWriteTarget(policy.workspaceRoot, hunk.path, policy.fileAccess, policy.workspaceAlias);
      if (!verdict.ok) {
        return { ok: false, code: verdict.code, message: `apply_patch target refused for '${hunk.path}': ${verdict.code}` };
      }
      targets.push({ kind: "add", hunk, absolutePath: verdict.absolutePath });
      continue;
    }
    if (hunk.kind === "delete") {
      const verdict = resolveInsideWorkspace(policy.workspaceRoot, hunk.path, policy.fileAccess, policy.workspaceAlias);
      if (!verdict.ok) {
        return { ok: false, code: verdict.code, message: `apply_patch target refused for '${hunk.path}': ${verdict.code}` };
      }
      targets.push({ kind: "delete", hunk, absolutePath: verdict.absolutePath });
      continue;
    }
    const source = resolveInsideWorkspace(policy.workspaceRoot, hunk.path, policy.fileAccess, policy.workspaceAlias);
    if (!source.ok) {
      return { ok: false, code: source.code, message: `apply_patch target refused for '${hunk.path}': ${source.code}` };
    }
    if (hunk.moveTo === undefined) {
      targets.push({ kind: "update", hunk, absolutePath: source.absolutePath, moveAbsolute: undefined });
      continue;
    }
    const destination = resolveWriteTarget(policy.workspaceRoot, hunk.moveTo, policy.fileAccess, policy.workspaceAlias);
    if (!destination.ok) {
      return { ok: false, code: destination.code, message: `apply_patch move destination refused for '${hunk.moveTo}': ${destination.code}` };
    }
    targets.push({ kind: "update", hunk, absolutePath: source.absolutePath, moveAbsolute: destination.absolutePath });
  }
  return { ok: true, targets };
}

function changeToJson(entry: AppliedFileChange): JsonObject {
  if (entry.op === "added") {
    return { op: entry.op, path: entry.path, bytes: entry.bytes, mode: entry.mode, preview: entry.preview };
  }
  if (entry.op === "deleted") {
    return { op: entry.op, path: entry.path, bytes: entry.bytes, preview: entry.preview };
  }
  if (entry.op === "moved") {
    return {
      op: entry.op,
      from: entry.from,
      path: entry.path,
      bytes: entry.bytes,
      preview: entry.preview,
      ...(entry.overwrote === true ? { overwrote: true } : {}),
    };
  }
  return { op: entry.op, path: entry.path, bytes: entry.bytes, preview: entry.preview };
}

function fileWriteOf(entry: AppliedFileChange): JsonObject {
  if (entry.op === "added") {
    return { kind: "file_write", path: entry.path, bytes: entry.bytes, mode: entry.mode };
  }
  if (entry.op === "deleted") {
    // Nothing was written; bytes counts written bytes, and the preview on the
    // change entry carries the removed content.
    return { kind: "file_write", path: entry.path, bytes: 0, mode: "deleted" };
  }
  if (entry.op === "moved") {
    return { kind: "file_write", path: entry.path, bytes: entry.bytes, mode: "moved" };
  }
  return { kind: "file_write", path: entry.path, bytes: entry.bytes, mode: "patched" };
}

export async function executeApplyPatch(
  config: ApplyPatchConfig,
  request: ToolCallRequest,
  plan: MutationPlan,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (plan.tool !== APPLY_PATCH_TOOL) {
    return fail("invalid_arguments", "apply_patch received a foreign plan");
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const patch = request.arguments["patch"];
  if (typeof patch !== "string" || patch.length === 0) {
    return fail("invalid_arguments", "apply_patch requires patch");
  }
  const parsed = parseApplyPatch(patch);
  if (!parsed.ok) {
    return fail(parsed.code, parsed.message);
  }
  if (parsed.hunks.length === 0) {
    return fail("empty_patch", "empty_patch: no files were modified");
  }
  const resolved = resolveAll(config.policy, parsed.hunks);
  if (!resolved.ok) {
    return fail(resolved.code, resolved.message);
  }
  const accumulator: AppliedAccumulator = { changes: [], exact: true };
  for (let index = 0; index < resolved.targets.length; index += 1) {
    const target = resolved.targets[index];
    if (target === undefined) {
      continue;
    }
    const context = { config, accumulator, targets: resolved.targets, atIndex: index, signal };
    if (signal.aborted) {
      return abortOutcome(context);
    }
    const failed =
      target.kind === "add"
        ? await commitAdd(context, target, target.hunk.path)
        : target.kind === "delete"
          ? await commitDelete(context, target, target.hunk.path)
          : await commitUpdate(context, target, target.hunk.path);
    if (failed !== undefined) {
      return failed;
    }
  }
  // Every hunk landed: the work is complete, so success is reported with its
  // facts even if the abort fired afterwards. There is no post-write recheck
  // here for the same reason `write_file` has none — bytes on disk decide.
  const value: JsonObject = {
    applied: accumulator.changes.map(changeToJson),
    exact: accumulator.exact,
    fileWrites: accumulator.changes.map(fileWriteOf),
  };
  const summary = ["Success. Updated the following files:", ...summarizeLines(accumulator.changes)].join("\n");
  return { outcome: "result", value, output: summary, truncated: false };
}

export type { AppliedFileChange, ApplyPatchConfig };
