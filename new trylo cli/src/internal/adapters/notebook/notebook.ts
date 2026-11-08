import type { JsonObject, JsonValue } from "../../protocol/envelope.js";

/**
 * Notebook mechanical layer (WP13.2/13.3: L12, L13).
 *
 * Pure functions ported from the legacy CLI, no filesystem, no clock, no
 * randomness, no process surface: parsed JSON in, cell views and edited cell
 * lists out. Randomness (new cell ids) is a caller-provided string — this
 * module never picks one, so the static ambient-source scan has nothing to
 * flag here.
 *
 * Reuse (mechanical layer only, types stay Trylo-owned):
 * - legacy `src/utils/notebook.ts` — `readNotebook` cell joining, `processCell`
 *   language/output rules, `processOutput` text/image branches, `extractImage`
 *   png/jpeg allowlist, `parseCellId` (`cell-N`), large-output placeholder;
 * - legacy `src/tools/NotebookEditTool/NotebookEditTool.ts` — insert/replace/
 *   delete addressing (exact id, then `cell-N` fallback), replace-at-end
 *   becomes insert, code replace clears outputs and nulls execution count,
 *   `IPYNB_INDENT = 1` write-back.
 *
 * Deliberate deltas vs legacy, all recorded in the WP13 construction record:
 * - no `nbformat >= 4.5` gate on new ids: Trylo always assigns the
 *   caller-provided id on insert (legacy readers ignore the extra field);
 * - the large-output placeholder names `read_notebook` with `cell_id`
 *   instead of `BashTool` + `jq` (Trylo must not assume POSIX utilities);
 * - per-output text is capped at `NOTEBOOK_OUTPUT_TEXT_CAP` with an explicit
 *   truncation marker (legacy caps through `formatOutput`; the ceiling value
 *   is Trylo's own contract, stated here, not inherited silently).
 */

/** Outputs larger than this (text + image bytes summed) are withheld unless a single cell is read. */
export const NOTEBOOK_LARGE_OUTPUT_THRESHOLD = 10_000;

/** Single output text is never handed to the model beyond this; the cut is marked. */
export const NOTEBOOK_OUTPUT_TEXT_CAP = 10_000;

/** Whole-notebook serialized views must fit the caller's byte ceiling or the read refuses. */
export const NOTEBOOK_INDENT = 1;

export type NotebookCellType = "code" | "markdown" | "raw";

export type NotebookEditMode = "replace" | "insert" | "delete";

export function isNotebookCellType(value: string): value is NotebookCellType {
  return value === "code" || value === "markdown" || value === "raw";
}

export function isNotebookEditMode(value: string): value is NotebookEditMode {
  return value === "replace" || value === "insert" || value === "delete";
}

export type NotebookOutputImage = {
  readonly image_data: string;
  readonly media_type: string;
};

export type NotebookCellOutputView = {
  readonly output_type: string;
  readonly text: string;
  readonly image?: NotebookOutputImage | undefined;
};

export type NotebookCellRecord = {
  readonly cellType: string;
  readonly cellId: string | undefined;
  /** Joined source, model-facing. */
  readonly source: string;
  /** Write-back shape: untouched cells keep their original string-or-array form. */
  readonly sourceRaw: string | ReadonlyArray<string>;
  readonly metadata: JsonObject;
  readonly language: string | undefined;
  readonly executionCount: number | null | undefined;
  /** Raw outputs for write-back; `undefined` for non-code cells. */
  readonly outputs: ReadonlyArray<JsonObject> | undefined;
  /** Model-facing output views; `undefined` for non-code cells. */
  readonly outputViews: ReadonlyArray<NotebookCellOutputView> | undefined;
};

export type NotebookDocument = {
  /** Full original object: unknown top-level keys (kernelspec, …) survive write-back. */
  readonly raw: JsonObject;
  readonly cells: ReadonlyArray<NotebookCellRecord>;
  readonly language: string;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export type NotebookParseResult =
  | { readonly ok: true; readonly document: NotebookDocument }
  | { readonly ok: false; readonly code: "invalid_notebook"; readonly message: string };

function invalid(message: string): NotebookParseResult {
  return { ok: false, code: "invalid_notebook", message: `invalid_notebook: ${message}` };
}

/**
 * Parse and shape-guard a notebook file. Anything that is not a JSON object
 * with a `cells` array of well-formed cells refuses here — a blind cast would
 * turn a corrupt file into invented cells, which is exactly the failure mode
 * the WP13.2 acceptance forbids ("非法 JSON 原文件不变" starts with not
 * believing it).
 */
export function parseNotebookDocument(text: string): NotebookParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("file is not valid JSON");
  }

  if (!isJsonObject(parsed)) {
    return invalid("top level is not an object");
  }

  const cellsValue: JsonValue = parsed["cells"] ?? [];
  if (!Array.isArray(cellsValue)) {
    return invalid('missing "cells" array');
  }

  const metadataValue = parsed["metadata"];
  const languageInfo = isJsonObject(metadataValue) ? metadataValue["language_info"] : undefined;
  const languageName = isJsonObject(languageInfo) ? languageInfo["name"] : undefined;
  const language = typeof languageName === "string" ? languageName : "python";
  const cells: NotebookCellRecord[] = [];

  for (let index = 0; index < cellsValue.length; index += 1) {
    const rawCell = cellsValue[index];
    if (!isJsonObject(rawCell)) {
      return invalid(`cell ${index} is not an object`);
    }

    const cellTypeValue = rawCell["cell_type"];
    if (typeof cellTypeValue !== "string") {
      return invalid(`cell ${index} has no string cell_type`);
    }

    const sourceValue = rawCell["source"];
    if (typeof sourceValue !== "string" && !isStringArray(sourceValue)) {
      return invalid(`cell ${index} has no string-or-array source`);
    }

    const idValue = rawCell["id"];
    if (idValue !== undefined && typeof idValue !== "string") {
      return invalid(`cell ${index} has a non-string id`);
    }

    const metadataCell = rawCell["metadata"];
    if (metadataCell !== undefined && !isJsonObject(metadataCell)) {
      return invalid(`cell ${index} has non-object metadata`);
    }

    const executionValue = rawCell["execution_count"];
    if (
      executionValue !== undefined &&
      executionValue !== null &&
      typeof executionValue !== "number"
    ) {
      return invalid(`cell ${index} has a non-numeric execution_count`);
    }

    const executionCount: number | null | undefined =
      typeof executionValue === "number" ? executionValue : executionValue === null ? null : undefined;
    const outputsValue = rawCell["outputs"];
    if (outputsValue !== undefined && !Array.isArray(outputsValue)) {
      return invalid(`cell ${index} has non-array outputs`);
    }

    const source = typeof sourceValue === "string" ? sourceValue : sourceValue.join("");
    const isCode = cellTypeValue === "code";

    cells.push({
      cellType: cellTypeValue,
      cellId: idValue,
      source,
      sourceRaw: typeof sourceValue === "string" ? sourceValue : [...sourceValue],
      metadata: metadataCell === undefined ? {} : metadataCell,
      language: isCode ? language : undefined,
      executionCount: isCode ? executionCount : undefined,
      outputs: isCode && outputsValue !== undefined
        ? outputsValue.filter(isJsonObject)
        : isCode
          ? []
          : undefined,
      outputViews: undefined,
    });
  }

  const withViews = cells.map((cell, index) => attachOutputViews(cell, index, language, false));

  return { ok: true, document: { raw: parsed, cells: withViews, language } };
}

function capText(text: string): { readonly text: string; readonly cut: number } {
  if (text.length <= NOTEBOOK_OUTPUT_TEXT_CAP) {
    return { text, cut: 0 };
  }
  const cut = text.length - NOTEBOOK_OUTPUT_TEXT_CAP;
  return { text: `${text.slice(0, NOTEBOOK_OUTPUT_TEXT_CAP)}…(truncated ${cut} chars)`, cut };
}

function plainTextOf(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.filter((entry): entry is string => typeof entry === "string").join("");
  }

  return "";
}

function extractOutputImage(data: JsonObject): NotebookOutputImage | undefined {
  const png = data["image/png"];
  if (typeof png === "string") {
    return { image_data: png.replace(/\s/g, ""), media_type: "image/png" };
  }

  const jpeg = data["image/jpeg"];
  if (typeof jpeg === "string") {
    return { image_data: jpeg.replace(/\s/g, ""), media_type: "image/jpeg" };
  }

  return undefined;
}

function viewOfOutput(output: JsonObject): NotebookCellOutputView {
  const kindValue = output["output_type"];
  const kind = typeof kindValue === "string" ? kindValue : "unknown";
  if (kind === "stream") {
    return { output_type: kind, text: capText(plainTextOf(output["text"])).text };
  }

  if (kind === "execute_result" || kind === "display_data") {
    const data = output["data"];
    const dataObject = isJsonObject(data) ? data : {};
    const text = capText(plainTextOf(dataObject["text/plain"])).text;
    const image = extractOutputImage(dataObject);

    return image === undefined
      ? { output_type: kind, text }
      : { output_type: kind, text, image };
  }

  if (kind === "error") {
    const nameValue = output["ename"];
    const valueValue = output["evalue"];
    const traceValue = output["traceback"];
    const name = typeof nameValue === "string" ? nameValue : "error";
    const value = typeof valueValue === "string" ? valueValue : "";
    const trace = Array.isArray(traceValue)
      ? traceValue.filter((entry): entry is string => typeof entry === "string").join("\n")
      : "";

    return { output_type: kind, text: capText(`${name}: ${value}\n${trace}`).text };
  }

  return { output_type: kind, text: "" };
}

function outputsSize(views: ReadonlyArray<NotebookCellOutputView>): number {
  let size = 0;
  for (const view of views) {
    size += view.text.length + (view.image?.image_data.length ?? 0);
  }
  return size;
}

function largeOutputsPlaceholder(cellIndex: number): NotebookCellOutputView {
  return {
    output_type: "stream",
    text: `Outputs are too large to include. Read this cell alone with read_notebook cell_id "cell-${cellIndex}".`,
  };
}

function attachOutputViews(
  cell: NotebookCellRecord,
  index: number,
  language: string,
  includeLargeOutputs: boolean,
): NotebookCellRecord {
  if (cell.cellType !== "code" || cell.outputs === undefined || cell.outputs.length === 0) {
    return { ...cell, language: cell.cellType === "code" ? language : undefined };
  }

  const views = cell.outputs.map(viewOfOutput);
  if (!includeLargeOutputs && outputsSize(views) > NOTEBOOK_LARGE_OUTPUT_THRESHOLD) {
    return {
      ...cell,
      language,
      outputViews: [largeOutputsPlaceholder(index)],
    };
  }

  return { ...cell, language, outputViews: views };
}

/** Model-facing views for every cell; single-cell reads pass `largeOutputs: true`. */
export function cellViewsForTool(
  document: NotebookDocument,
  options?: { readonly largeOutputs?: boolean | undefined },
): ReadonlyArray<NotebookCellRecord> {
  const large = options?.largeOutputs ?? false;
  return document.cells.map((cell, index) => attachOutputViews(cell, index, document.language, large));
}

/**
 * `<cell id="…">` serialization, ported from legacy `cellContentToToolResult`:
 * non-code cells name their type, non-python code cells name their language.
 * Output texts follow the cell, one per line; images travel as a named
 * placeholder in text (bytes stay in the structured value for the WP19 wire).
 */
export function serializeCellsForTool(cells: ReadonlyArray<NotebookCellRecord>): string {
  const parts: string[] = [];

  for (const cell of cells) {
    const metadata: string[] = [];

    if (cell.cellType !== "code") {
      metadata.push(`<cell_type>${cell.cellType}</cell_type>`);
    }

    if (cell.cellType === "code" && cell.language !== undefined && cell.language !== "python") {
      metadata.push(`<language>${cell.language}</language>`);
    }

    parts.push(`<cell id="${cell.cellId ?? "cell-unknown"}">${metadata.join("")}${cell.source}</cell>`);

    for (const output of cell.outputViews ?? []) {
      if (output.text.length > 0) {
        parts.push(output.text);
      }
      if (output.image !== undefined) {
        parts.push(`<image ${output.image.media_type} ${output.image.image_data.length} chars base64>`);
      }
    }
  }

  return parts.join("\n");
}

/** `cell-N` index fallback, ported from legacy `parseCellId`. */
export function parseCellId(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/.exec(cellId);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  const index = Number.parseInt(match[1], 10);
  return Number.isNaN(index) ? undefined : index;
}

export type CellLocation =
  | { readonly ok: true; readonly index: number }
  | { readonly ok: false; readonly code: "cell_not_found" | "cell_index_out_of_range"; readonly message: string };

/** Exact id first, then the `cell-N` positional fallback — legacy addressing, unchanged. */
export function locateCellIndex(
  cells: ReadonlyArray<NotebookCellRecord>,
  cellId: string,
): CellLocation {
  const exact = cells.findIndex((cell) => cell.cellId === cellId);
  if (exact !== -1) {
    return { ok: true, index: exact };
  }

  const positional = parseCellId(cellId);
  if (positional === undefined) {
    return { ok: false, code: "cell_not_found", message: `cell_not_found: no cell with ID "${cellId}"` };
  }

  if (positional < 0 || positional >= cells.length) {
    return {
      ok: false,
      code: "cell_index_out_of_range",
      message: `cell_index_out_of_range: cell index ${positional} does not exist`,
    };
  }

  return { ok: true, index: positional };
}

export type NotebookEditInput = {
  readonly cell_id?: string | undefined;
  readonly new_source: string;
  readonly cell_type?: NotebookCellType | undefined;
  readonly edit_mode: NotebookEditMode;
  /** Caller-provided id for inserted cells; this module never invents one. */
  readonly newCellId: string;
};

export type NotebookEditResult =
  | {
    readonly ok: true;
    readonly cells: ReadonlyArray<NotebookCellRecord>;
    readonly appliedCellId: string | undefined;
    readonly editMode: NotebookEditMode;
  }
  | {
    readonly ok: false;
    readonly code:
      | "missing_cell_id"
      | "missing_cell_type"
      | "cell_not_found"
      | "cell_index_out_of_range";
    readonly message: string;
  };

/**
 * Insert/replace/delete over a parsed cell list. Semantics are the legacy
 * `NotebookEditTool.call` algorithm with the IO removed: insert defaults to
 * position 0 without an anchor, otherwise after the anchor; replace at
 * one-past-the-end becomes insert; replacing a code cell clears its outputs
 * and nulls its execution count (stale results must not survive an edit).
 */
export function applyNotebookEdit(
  cells: ReadonlyArray<NotebookCellRecord>,
  input: NotebookEditInput,
): NotebookEditResult {
  if (input.edit_mode === "insert" && input.cell_type === undefined) {
    return {
      ok: false,
      code: "missing_cell_type",
      message: "missing_cell_type: cell_type is required when edit_mode=insert",
    };
  }

  if (input.edit_mode !== "insert" && input.cell_id === undefined) {
    return {
      ok: false,
      code: "missing_cell_id",
      message: "missing_cell_id: cell_id is required when edit_mode is replace or delete",
    };
  }

  let index: number;

  if (input.cell_id === undefined) {
    index = 0;
  } else {
    const located = locateCellIndex(cells, input.cell_id);
    if (!located.ok) {
      return located;
    }
    index = input.edit_mode === "insert" ? located.index + 1 : located.index;
  }

  // Convert replace to insert if trying to replace one past the end (legacy
  // `NotebookEditTool.call` parity). Unreachable through `locateCellIndex`,
  // which refuses `cell-N == length` first — kept as TOCTOU defense for
  // callers that address cells another way.
  let mode = input.edit_mode;
  if (mode === "replace" && index === cells.length) {
    mode = "insert";
  }

  const next = [...cells];

  if (mode === "delete") {
    next.splice(index, 1);
    return { ok: true, cells: next, appliedCellId: undefined, editMode: mode };
  }

  if (mode === "insert") {
    const kind = input.cell_type ?? "code";
    const inserted: NotebookCellRecord = kind === "markdown"
      ? {
        cellType: "markdown",
        cellId: input.newCellId,
        source: input.new_source,
        sourceRaw: input.new_source,
        metadata: {},
        language: undefined,
        executionCount: undefined,
        outputs: undefined,
        outputViews: undefined,
      }
      : {
        cellType: "code",
        cellId: input.newCellId,
        source: input.new_source,
        sourceRaw: input.new_source,
        metadata: {},
        language: undefined,
        executionCount: null,
        outputs: [],
        outputViews: [],
      };

    next.splice(index, 0, inserted);

    return { ok: true, cells: next, appliedCellId: input.newCellId, editMode: mode };
  }

  const target = next[index];
  if (target === undefined) {
    return {
      ok: false,
      code: "cell_index_out_of_range",
      message: `cell_index_out_of_range: cell index ${index} does not exist`,
    };
  }

  const cleared = target.cellType === "code";

  next[index] = {
    ...target,
    cellType: input.cell_type ?? target.cellType,
    source: input.new_source,
    sourceRaw: input.new_source,
    executionCount: cleared ? null : target.executionCount,
    outputs: cleared ? [] : target.outputs,
    outputViews: cleared ? [] : target.outputViews,
  };

  return { ok: true, cells: next, appliedCellId: target.cellId, editMode: mode };
}

function cellToRaw(cell: NotebookCellRecord): JsonObject {
  const raw: Record<string, JsonValue> = {
    cell_type: cell.cellType,
    source: typeof cell.sourceRaw === "string" ? cell.sourceRaw : [...cell.sourceRaw],
    metadata: cell.metadata,
  };

  if (cell.cellId !== undefined) {
    raw["id"] = cell.cellId;
  }

  if (cell.cellType === "code") {
    raw["execution_count"] = cell.executionCount ?? null;
    raw["outputs"] = cell.outputs === undefined ? [] : [...cell.outputs];
  }

  return raw;
}

/**
 * Write-back: the original top-level object with only `cells` replaced, then
 * `JSON.stringify` at indent 1 (legacy `IPYNB_INDENT`). Metadata, outputs and
 * untouched cells keep their parsed shape; the file stays a valid notebook.
 */
export function serializeNotebook(
  raw: JsonObject,
  cells: ReadonlyArray<NotebookCellRecord>,
): string {
  return JSON.stringify({ ...raw, cells: cells.map(cellToRaw) }, null, NOTEBOOK_INDENT);
}
