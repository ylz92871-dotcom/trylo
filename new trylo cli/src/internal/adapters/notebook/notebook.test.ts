import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyNotebookEdit,
  cellViewsForTool,
  locateCellIndex,
  parseCellId,
  parseNotebookDocument,
  serializeCellsForTool,
  serializeNotebook,
} from "./notebook.js";

/**
 * WP13.2/13.3 (L12, L13) red cover: the cell algorithms `read_notebook` and
 * `notebook_edit` execute. A case that fails here fails the same way through
 * either tool — the tools add containment and disk IO, not judgment.
 */

function sample(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: "python" }, kernelspec: { name: "py" } },
    cells: [
      {
        id: "a1",
        cell_type: "code",
        source: ["x = 1"],
        metadata: { trusted: true },
        execution_count: 2,
        outputs: [{ output_type: "stream", text: "hi" }],
      },
      { id: "m1", cell_type: "markdown", source: "# title", metadata: {} },
    ],
  });
}

test("a well-formed notebook parses with ids, language, and output views", () => {
  const parsed = parseNotebookDocument(sample());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.document.cells.length, 2);
  assert.equal(parsed.document.language, "python");
  assert.equal(parsed.document.cells[0]?.cellId, "a1");
  assert.equal(parsed.document.cells[0]?.executionCount, 2);
  assert.equal(parsed.document.cells[0]?.outputViews?.length, 1);
  assert.equal(parsed.document.cells[1]?.language, undefined);
});

test("malformed notebooks refuse without inventing cells", () => {
  for (const bad of [
    "{not json",
    "[1,2]",
    JSON.stringify({ cells: "nope" }),
    JSON.stringify({ cells: [{ cell_type: "code" }] }),
    JSON.stringify({ cells: [{ cell_type: "code", source: 42 }] }),
    JSON.stringify({ cells: [{ cell_type: "code", source: "x", id: 7 }] }),
    JSON.stringify({ cells: [{ cell_type: "code", source: "x", metadata: [] }] }),
    JSON.stringify({ cells: [{ cell_type: "code", source: "x", execution_count: "many" }] }),
    JSON.stringify({ cells: [{ cell_type: "code", source: "x", outputs: {} }] }),
  ]) {
    const parsed = parseNotebookDocument(bad);
    assert.equal(parsed.ok, false, bad.slice(0, 40));
    if (!parsed.ok) {
      assert.equal(parsed.code, "invalid_notebook");
    }
  }
});

test("cell addressing: exact id wins, cell-N falls back, unknown refuses", () => {
  const parsed = parseNotebookDocument(sample());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.deepEqual(locateCellIndex(parsed.document.cells, "m1"), { ok: true, index: 1 });
  assert.deepEqual(locateCellIndex(parsed.document.cells, "cell-0"), { ok: true, index: 0 });
  assert.equal(parseCellId("cell-12"), 12);
  assert.equal(parseCellId("a1"), undefined);
  const missing = locateCellIndex(parsed.document.cells, "zzz");

  assert.equal(missing.ok, false);

  if (!missing.ok) {
    assert.equal(missing.code, "cell_not_found");
  }

  const pastEnd = locateCellIndex(parsed.document.cells, "cell-9");

  assert.equal(pastEnd.ok, false);

  if (!pastEnd.ok) {
    assert.equal(pastEnd.code, "cell_index_out_of_range");
  }
});

test("tool serialization names non-code types and non-python languages", () => {
  const parsed = parseNotebookDocument(sample());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const text = serializeCellsForTool(cellViewsForTool(parsed.document));

  assert.ok(text.includes('<cell id="a1">x = 1</cell>'));
  assert.ok(text.includes("<cell_type>markdown</cell_type>"));
  assert.ok(text.includes("hi"));
});

test("large outputs are withheld for whole reads and included for single cells", () => {
  const big = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: "big",
        cell_type: "code",
        source: "run()",
        metadata: {},
        execution_count: 1,
        outputs: [{ output_type: "stream", text: "z".repeat(20_000) }],
      },
    ],
  });
  const parsed = parseNotebookDocument(big);

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const whole = cellViewsForTool(parsed.document)[0]?.outputViews?.[0]?.text ?? "";

  assert.ok(whole.includes("read_notebook"));
  assert.ok(!whole.includes("z".repeat(100)));
  const single = cellViewsForTool(parsed.document, { largeOutputs: true })[0]?.outputViews?.[0]?.text ?? "";

  assert.ok(single.startsWith("z"));
  assert.ok(single.includes("truncated"));
});

test("replace clears stale outputs, keeps metadata and untouched cells", () => {
  const parsed = parseNotebookDocument(sample());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const edited = applyNotebookEdit(parsed.document.cells, {
    cell_id: "a1",
    new_source: "x = 2",
    edit_mode: "replace",
    newCellId: "unused",
  });

  assert.equal(edited.ok, true);

  if (!edited.ok) {
    return;
  }

  assert.equal(edited.appliedCellId, "a1");
  const cell = edited.cells[0];

  assert.equal(cell?.source, "x = 2");
  assert.equal(cell?.executionCount, null);
  assert.deepEqual(cell?.outputs, []);
  assert.deepEqual(cell?.metadata, { trusted: true });
  assert.equal(edited.cells[1]?.source, "# title");
  // The untouched markdown cell keeps its identity for write-back.
  assert.equal(edited.cells[1]?.cellId, "m1");
});

test("insert anchors after the cell, or at the top without one; type is required", () => {
  const parsed = parseNotebookDocument(sample());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const noType = applyNotebookEdit(parsed.document.cells, {
    cell_id: "a1",
    new_source: "y",
    edit_mode: "insert",
    newCellId: "n1",
  });

  assert.equal(noType.ok, false);

  if (!noType.ok) {
    assert.equal(noType.code, "missing_cell_type");
  }

  const after = applyNotebookEdit(parsed.document.cells, {
    cell_id: "a1",
    new_source: "y = 1",
    cell_type: "code",
    edit_mode: "insert",
    newCellId: "n1",
  });

  assert.equal(after.ok, true);

  if (!after.ok) {
    return;
  }

  assert.equal(after.cells.length, 3);
  assert.equal(after.cells[1]?.cellId, "n1");
  assert.equal(after.cells[1]?.executionCount, null);
  assert.equal(after.appliedCellId, "n1");
  const top = applyNotebookEdit(parsed.document.cells, {
    new_source: "# head",
    cell_type: "markdown",
    edit_mode: "insert",
    newCellId: "n0",
  });

  assert.equal(top.ok, true);

  if (!top.ok) {
    return;
  }

  assert.equal(top.cells[0]?.cellId, "n0");
  assert.equal(top.cells[0]?.cellType, "markdown");
});

test("delete removes exactly one cell; replace past the end becomes insert", () => {
  const parsed = parseNotebookDocument(sample());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const deleted = applyNotebookEdit(parsed.document.cells, {
    cell_id: "m1",
    new_source: "ignored",
    edit_mode: "delete",
    newCellId: "unused",
  });

  assert.equal(deleted.ok, true);

  if (!deleted.ok) {
    return;
  }

  assert.equal(deleted.cells.length, 1);
  assert.equal(deleted.cells[0]?.cellId, "a1");
  const noId = applyNotebookEdit(parsed.document.cells, {
    new_source: "x",
    edit_mode: "replace",
    newCellId: "unused",
  });

  assert.equal(noId.ok, false);

  if (!noId.ok) {
    assert.equal(noId.code, "missing_cell_id");
  }

  // `cell-N == length` addresses one past the end: like legacy validation it
  // refuses for replace (the replace-at-end→insert conversion in
  // `applyNotebookEdit` stays as TOCTOU defense, mirroring legacy `call()`),
  // while insert after the last cell appends.
  const pastEnd = applyNotebookEdit(parsed.document.cells, {
    cell_id: "cell-2",
    new_source: "tail = 1",
    edit_mode: "replace",
    newCellId: "unused",
  });

  assert.equal(pastEnd.ok, false);

  if (!pastEnd.ok) {
    assert.equal(pastEnd.code, "cell_index_out_of_range");
  }

  const appended = applyNotebookEdit(parsed.document.cells, {
    cell_id: "cell-1",
    new_source: "tail = 1",
    cell_type: "code",
    edit_mode: "insert",
    newCellId: "n9",
  });

  assert.equal(appended.ok, true);

  if (!appended.ok) {
    return;
  }

  assert.equal(appended.editMode, "insert");
  assert.equal(appended.cells.length, 3);
  assert.equal(appended.cells[2]?.cellId, "n9");
});

test("write-back keeps unknown top-level keys and uses indent 1", () => {
  const parsed = parseNotebookDocument(sample());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const edited = applyNotebookEdit(parsed.document.cells, {
    cell_id: "a1",
    new_source: "x = 2",
    edit_mode: "replace",
    newCellId: "unused",
  });

  assert.equal(edited.ok, true);

  if (!edited.ok) {
    return;
  }

  const text = serializeNotebook(parsed.document.raw, edited.cells);
  const roundTrip = parseNotebookDocument(text);

  assert.equal(roundTrip.ok, true);
  // Indent 1: the second line starts with exactly one space.
  assert.ok(text.split("\n")[1]?.startsWith(' "'));

  if (!roundTrip.ok) {
    return;
  }

  assert.equal(roundTrip.document.cells[0]?.source, "x = 2");
  assert.deepEqual(roundTrip.document.raw["nbformat"], 4);
  assert.ok(JSON.stringify(roundTrip.document.raw).includes("kernelspec"));
});
