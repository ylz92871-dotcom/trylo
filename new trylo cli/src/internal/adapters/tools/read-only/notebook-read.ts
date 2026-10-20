import type { JsonObject, JsonValue } from "../../../protocol/envelope.js";
import type { FileAccessMode, ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import {
  cellViewsForTool,
  parseNotebookDocument,
  serializeCellsForTool,
  type NotebookCellRecord,
} from "../../notebook/notebook.js";
import { readStringArg } from "./args.js";
import type { FileSystemReader, ReadOnlyToolLimits } from "./limits.js";
import { resolveInsideWorkspace } from "./workspace.js";

export const READ_NOTEBOOK_TOOL = "read_notebook";

export type NotebookReadConfig = {
  readonly workspaceRoot: string;
  readonly fileAccess?: FileAccessMode;
  readonly workspaceAlias?: string;
  readonly reader: FileSystemReader;
};

function fail(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

function cellValue(cell: NotebookCellRecord): JsonObject {
  const value: Record<string, JsonValue> = {
    cell_id: cell.cellId ?? "cell-unknown",
    cellType: cell.cellType,
    source: cell.source,
  };
  if (cell.language !== undefined) {
    value["language"] = cell.language;
  }
  if (cell.executionCount !== undefined) {
    value["executionCount"] = cell.executionCount;
  }
  const views = cell.outputViews ?? [];
  if (views.length > 0) {
    value["outputs"] = views.map((view) => {
      const entry: Record<string, JsonValue> = {
        output_type: view.output_type,
        text: view.text,
      };
      if (view.image !== undefined) {
        entry["image"] = { media_type: view.image.media_type, image_data: view.image.image_data };
      }
      return entry;
    });
  }
  return value;
}

/**
 * `read_notebook` (WP13.2: L12).
 *
 * Cell-aware reads ported from legacy `FileReadTool`'s `.ipynb` branch:
 * cells are parsed, shape-guarded, and serialized as `<cell id="…">` views
 * instead of raw file JSON. Without `cell_id` the whole notebook must fit the
 * caller's byte ceiling or the read refuses with a resume hint (legacy names
 * `jq`; Trylo names this same tool). With `cell_id` exactly one cell returns
 * and its large outputs are included. Anything that is not a well-formed
 * notebook refuses as `invalid_notebook` — never half-parsed cells.
 */
export async function executeReadNotebook(
  config: NotebookReadConfig,
  limits: ReadOnlyToolLimits,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const requested = readStringArg(call.arguments, "path");
  if (requested === undefined) {
    return fail("invalid_arguments", "read_notebook requires path");
  }
  if (!requested.toLowerCase().endsWith(".ipynb")) {
    return fail("invalid_arguments", "read_notebook only reads .ipynb files; use read_file for text");
  }
  const cellId = readStringArg(call.arguments, "cell_id");
  const verdict = resolveInsideWorkspace(config.workspaceRoot, requested, config.fileAccess, config.workspaceAlias);
  if (!verdict.ok) {
    return fail(verdict.code, verdict.code);
  }
  let raw: string;
  try {
    raw = await config.reader.readFileUtf8(verdict.absolutePath, signal);
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = error instanceof Error ? error.message : "read_error";
    return fail("read_failed", `read_failed:${detail}`);
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const parsed = parseNotebookDocument(raw);
  if (!parsed.ok) {
    return fail(parsed.code, parsed.message);
  }
  if (cellId !== undefined) {
    const index = parsed.document.cells.findIndex((cell) => cell.cellId === cellId);
    if (index === -1) {
      return fail("cell_not_found", `cell_not_found: no cell with ID "${cellId}"`);
    }
    const single = cellViewsForTool(parsed.document, { largeOutputs: true })[index];
    if (single === undefined) {
      return fail("cell_not_found", `cell_not_found: no cell with ID "${cellId}"`);
    }
    const value: JsonObject = {
      path: requested,
      cells: [cellValue(single)],
      cellCount: parsed.document.cells.length,
    };
    return {
      outcome: "result",
      value,
      output: serializeCellsForTool([single]),
      truncated: false,
    };
  }
  const views = cellViewsForTool(parsed.document);
  const text = serializeCellsForTool(views);
  // The ceiling is shared with `read_file`: a notebook that does not fit is a
  // refusal with a resume path, not a silent prefix.
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
    return fail(
      "notebook_too_large",
      `notebook_too_large: ${views.length} cells exceed the ${limits.maxBytes} byte ceiling; read one cell with cell_id`,
    );
  }
  const value: JsonObject = {
    path: requested,
    cells: views.map(cellValue),
    cellCount: views.length,
  };
  return { outcome: "result", value, output: text, truncated: false };
}
