import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import type { MutationPlan } from "../../sandbox/planner.js";
import {
  applyNotebookEdit,
  isNotebookCellType,
  isNotebookEditMode,
  parseNotebookDocument,
  serializeNotebook,
  type NotebookCellType,
  type NotebookEditMode,
} from "../../notebook/notebook.js";
import { readFileUtf8, writeFileAtomicallySync, type WriteQueue } from "./atomic-write.js";
import { NOTEBOOK_EDIT_TOOL } from "./names.js";

export type NotebookEditRunnerConfig = {
  readonly writeQueue: WriteQueue;
  /**
   * New cell ids. Injected so tests are deterministic; production falls back
   * to a random suffix on the same line (the `??` keeps the ambient-source
   * scan honest about it being a default, not a hidden clock).
   */
  readonly idGenerator?: (() => string) | undefined;
};

function fail(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

/**
 * `notebook_edit` (WP13.2/13.3: L13).
 *
 * Cell insert/replace/delete ported from legacy `NotebookEditTool.call` with
 * the Trylo boundaries swapped in: workspace containment and the existing-file
 * gate live in the sandbox planner, the write goes through the shared atomic
 * queue, and the outcome carries the canonical `fileWrite` fact so the journal
 * and the turn's checkpoint-before-write cover it like every other mutation.
 *
 * Failure contract (WP13.3 acceptance: "文件损坏/写入失败不伪造成功"):
 * an unreadable file is `read_failed`, a corrupt file is `invalid_notebook`,
 * a missing cell is `cell_not_found` — all returned before anything touches
 * the disk, so the original file stays byte-identical. A failed write is
 * `write_failed`, never success. Cancellation is checked before the read and
 * before the write; an abort reports `cancelled`, never a partial edit.
 */
export async function executeNotebookEdit(
  config: NotebookEditRunnerConfig,
  request: ToolCallRequest,
  plan: MutationPlan,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (plan.tool !== NOTEBOOK_EDIT_TOOL) {
    return fail("invalid_arguments", "notebook_edit received a foreign plan");
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const sourceValue = request.arguments["new_source"];
  if (typeof sourceValue !== "string") {
    return fail("invalid_arguments", "notebook_edit requires new_source to be a string");
  }
  const cellIdValue = request.arguments["cell_id"];
  if (cellIdValue !== undefined && typeof cellIdValue !== "string") {
    return fail("invalid_arguments", "notebook_edit cell_id must be a string when present");
  }
  const cellType = readCellType(request.arguments["cell_type"]);
  if (cellType === "invalid") {
    return fail("invalid_arguments", "notebook_edit cell_type must be code, markdown, or raw");
  }
  const editMode = readEditMode(request.arguments["edit_mode"]);
  if (editMode === "invalid") {
    return fail("invalid_arguments", "notebook_edit edit_mode must be replace, insert, or delete");
  }
  const requestedValue = request.arguments["path"];
  const requestedPath = typeof requestedValue === "string" ? requestedValue : "";
  // One exclusivity section for the whole read-modify-write: the queue makes
  // same-file edits serial, so the bytes parsed are the bytes replaced. A new
  // cell id is minted once per call; deterministic under test injection.
  const generateId = config.idGenerator ?? ((): string => Math.random().toString(36).slice(2, 12));
  return config.writeQueue.exclusive(plan.absolutePath, () => {
    if (signal.aborted) {
      return Promise.resolve({ outcome: "cancelled" as const });
    }
    let current: string;
    try {
      current = readFileUtf8(plan.absolutePath);
    } catch (error) {
      if (signal.aborted) {
        return Promise.resolve({ outcome: "cancelled" as const });
      }
      const detail = error instanceof Error ? error.message : "read_error";
      return Promise.resolve(fail("read_failed", `read_failed:${detail}`));
    }
    const parsed = parseNotebookDocument(current);
    if (!parsed.ok) {
      // Untouched by construction: nothing has been written in this section.
      return Promise.resolve(fail(parsed.code, parsed.message));
    }
    const applied = applyNotebookEdit(parsed.document.cells, {
      ...(cellIdValue === undefined ? {} : { cell_id: cellIdValue }),
      new_source: sourceValue,
      ...(cellType === undefined ? {} : { cell_type: cellType }),
      edit_mode: editMode,
      newCellId: generateId(),
    });
    if (!applied.ok) {
      return Promise.resolve(fail(applied.code, applied.message));
    }
    if (signal.aborted) {
      return Promise.resolve({ outcome: "cancelled" as const });
    }
    const updated = serializeNotebook(parsed.document.raw, applied.cells);
    if (plan.maxWriteBytes !== undefined && Buffer.byteLength(updated, "utf8") > plan.maxWriteBytes) {
      return Promise.resolve(fail("write_too_large", `notebook_edit result exceeds the ${plan.maxWriteBytes} byte ceiling; no file was changed`));
    }
    try {
      const written = writeFileAtomicallySync(plan.absolutePath, updated);
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
        editMode: applied.editMode,
        ...(applied.appliedCellId === undefined ? {} : { appliedCellId: applied.appliedCellId }),
      };
      return Promise.resolve({
        outcome: "result" as const,
        value,
        output: `notebook_edit ${requestedPath} (${applied.editMode}${applied.appliedCellId === undefined ? "" : ` cell ${applied.appliedCellId}`}, ${written.bytes} bytes)`,
        truncated: false,
      });
    } catch (error) {
      // The atomic writer removes its own temp file; the destination was never
      // half-written, so reporting failure here is the truthful terminal state.
      if (signal.aborted) {
        return Promise.resolve({ outcome: "cancelled" as const });
      }
      const detail = error instanceof Error ? error.message : "write_error";
      return Promise.resolve(fail("write_failed", `write_failed:${detail}`));
    }
  });
}

function readCellType(value: unknown): NotebookCellType | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && isNotebookCellType(value) ? value : "invalid";
}

function readEditMode(value: unknown): NotebookEditMode | "invalid" {
  if (value === undefined) {
    return "replace";
  }
  return typeof value === "string" && isNotebookEditMode(value) ? value : "invalid";
}
