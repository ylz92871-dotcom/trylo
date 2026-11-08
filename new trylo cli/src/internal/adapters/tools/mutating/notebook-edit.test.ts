import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createReadOnlyTools } from "../read-only/index.js";
import { createNodeFileSystemReader } from "../read-only/node-fs.js";
import { READ_NOTEBOOK_TOOL } from "../read-only/notebook-read.js";
import { createMutatingTools } from "./index.js";
import { NOTEBOOK_EDIT_TOOL } from "./names.js";

/**
 * WP13.2/13.3 (L13) green cover through the real mutating ToolPort.
 *
 * Each success asserts the disk afterwards; each refusal asserts the file is
 * byte-identical to before — "we returned an error" and "nothing happened"
 * are two claims and only the second one is what WP13.3 is about. The
 * read-back half closes the loop through `read_notebook`, proving the two
 * tools agree on what a cell is.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-notebook-edit-"));
}

function toolsFor(root: string, idGenerator?: (() => string) | undefined) {
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root, maxWriteBytes: 1_000_000 });
  return createMutatingTools({
    sandbox,
    ...(idGenerator === undefined ? {} : { idGenerator }),
  });
}

function readersFor(root: string) {
  return createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
}

function sample(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: "python" } },
    cells: [
      {
        id: "a1",
        cell_type: "code",
        source: ["x = 1"],
        metadata: {},
        execution_count: 2,
        outputs: [{ output_type: "stream", text: "hi" }],
      },
      { id: "m1", cell_type: "markdown", source: "# title", metadata: {} },
    ],
  });
}

const SIGNAL = new AbortController().signal;

test("notebook_edit is registered as a workspace_write tool needing approval", () => {
  const root = tempRoot();
  try {
    const bindings = toolsFor(root).snapshot();
    const binding = bindings.find((entry) => entry.name === NOTEBOOK_EDIT_TOOL);
    assert.ok(binding !== undefined);
    assert.equal(binding?.sideEffect, "workspace_write");
    assert.equal(binding?.needsApproval, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replace rewrites one cell on disk and read_notebook sees the same cell", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    const tools = toolsFor(root);
    const outcome = await tools.execute(
      {
        toolCallId: "c1",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "exp.ipynb", cell_id: "a1", new_source: "x = 2" },
      },
      SIGNAL,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      const fileWrite = outcome.value.fileWrite as JsonObject;
      assert.equal(fileWrite["kind"], "file_write");
      assert.equal(fileWrite["mode"], "patched");
      assert.equal(outcome.value["editMode"], "replace");
      assert.equal(outcome.value["appliedCellId"], "a1");
    }

    const onDisk = JSON.parse(readFileSync(join(root, "exp.ipynb"), "utf8")) as JsonObject;
    const cells = onDisk["cells"] as ReadonlyArray<JsonObject>;

    assert.equal((cells[0]?.["source"] as string), "x = 2");
    assert.equal(cells[0]?.["execution_count"], null);
    assert.deepEqual(cells[0]?.["outputs"], []);
    assert.equal(cells[1]?.["source"], "# title");
    const readBack = await readersFor(root).execute(
      { toolCallId: "c2", name: READ_NOTEBOOK_TOOL, arguments: { path: "exp.ipynb", cell_id: "a1" } },
      SIGNAL,
    );

    assert.equal(readBack.outcome, "result");

    if (readBack.outcome === "result") {
      assert.ok(readBack.output.includes("x = 2"));
      assert.ok(!readBack.output.includes("x = 1"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("insert and delete change the cell list; insert mints the injected id", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    // The id is injected through the ToolPort factory, not invented inside
    // the test: this pins the whole path from catalog call to disk bytes.
    const tools = toolsFor(root, () => "cell-injected-1");
    const inserted = await tools.execute(
      {
        toolCallId: "c1",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "exp.ipynb", cell_id: "a1", new_source: "y = 1", cell_type: "code", edit_mode: "insert" },
      },
      SIGNAL,
    );

    assert.equal(inserted.outcome, "result");

    if (inserted.outcome === "result") {
      assert.equal(inserted.value["appliedCellId"], "cell-injected-1");
    }

    let afterInsert = JSON.parse(readFileSync(join(root, "exp.ipynb"), "utf8")) as JsonObject;

    assert.equal((afterInsert["cells"] as ReadonlyArray<unknown>).length, 3);
    assert.equal(((afterInsert["cells"] as ReadonlyArray<JsonObject>)[1]?.["id"]), "cell-injected-1");
    const deleted = await tools.execute(
      {
        toolCallId: "c2",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "exp.ipynb", cell_id: "m1", new_source: "ignored", edit_mode: "delete" },
      },
      SIGNAL,
    );

    assert.equal(deleted.outcome, "result");
    afterInsert = JSON.parse(readFileSync(join(root, "exp.ipynb"), "utf8")) as JsonObject;
    const cells = afterInsert["cells"] as ReadonlyArray<JsonObject>;

    assert.equal(cells.length, 2);
    assert.ok(!cells.some((cell) => cell["id"] === "m1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt notebooks, unknown cells, and bad modes refuse with the file untouched", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "bad.ipynb"), "{not json");
    writeFileSync(join(root, "exp.ipynb"), sample());
    const tools = toolsFor(root);
    const corrupt = await tools.execute(
      {
        toolCallId: "c1",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "bad.ipynb", cell_id: "a1", new_source: "x" },
      },
      SIGNAL,
    );

    assert.equal(corrupt.outcome, "error");

    if (corrupt.outcome === "error") {
      assert.equal(corrupt.code, "invalid_notebook");
    }

    assert.equal(readFileSync(join(root, "bad.ipynb"), "utf8"), "{not json");
    const before = readFileSync(join(root, "exp.ipynb"), "utf8");
    const unknown = await tools.execute(
      {
        toolCallId: "c2",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "exp.ipynb", cell_id: "zzz", new_source: "x" },
      },
      SIGNAL,
    );

    assert.equal(unknown.outcome, "error");

    if (unknown.outcome === "error") {
      assert.equal(unknown.code, "cell_not_found");
    }

    const badMode = await tools.execute(
      {
        toolCallId: "c3",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "exp.ipynb", cell_id: "a1", new_source: "x", edit_mode: "explode" },
      },
      SIGNAL,
    );

    assert.equal(badMode.outcome, "error");

    if (badMode.outcome === "error") {
      assert.equal(badMode.code, "invalid_arguments");
    }

    const noType = await tools.execute(
      {
        toolCallId: "c4",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "exp.ipynb", cell_id: "a1", new_source: "x", edit_mode: "insert" },
      },
      SIGNAL,
    );

    assert.equal(noType.outcome, "error");

    if (noType.outcome === "error") {
      assert.equal(noType.code, "missing_cell_type");
    }

    assert.equal(readFileSync(join(root, "exp.ipynb"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox gates hold: escapes, missing files, and non-ipynb targets never reach the disk", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    writeFileSync(join(root, "notes.txt"), "plain");
    const tools = toolsFor(root);
    const before = readFileSync(join(root, "exp.ipynb"), "utf8");
    const outside = await tools.execute(
      {
        toolCallId: "c1",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "../escape.ipynb", cell_id: "a1", new_source: "x" },
      },
      SIGNAL,
    );

    assert.equal(outside.outcome, "error");

    if (outside.outcome === "error") {
      // No hedge: `..` escapes resolve outside the root deterministically.
      assert.equal(outside.code, "path_outside_workspace");
    }

    const missing = await tools.execute(
      {
        toolCallId: "c2",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "gone.ipynb", cell_id: "a1", new_source: "x" },
      },
      SIGNAL,
    );

    assert.equal(missing.outcome, "error");

    if (missing.outcome === "error") {
      assert.equal(missing.code, "file_missing");
    }

    const notNotebook = await tools.execute(
      {
        toolCallId: "c3",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "notes.txt", cell_id: "a1", new_source: "x" },
      },
      SIGNAL,
    );

    assert.equal(notNotebook.outcome, "error");

    if (notNotebook.outcome === "error") {
      // The planner's extension gate fires before existence is even checked.
      assert.equal(notNotebook.code, "invalid_arguments");
    }

    assert.equal(readFileSync(join(root, "exp.ipynb"), "utf8"), before);
    assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "plain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted call reports cancelled and leaves the file alone", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    const before = readFileSync(join(root, "exp.ipynb"), "utf8");
    const aborted = new AbortController();

    aborted.abort();
    const outcome = await toolsFor(root).execute(
      {
        toolCallId: "c1",
        name: NOTEBOOK_EDIT_TOOL,
        arguments: { path: "exp.ipynb", cell_id: "a1", new_source: "x" },
      },
      aborted.signal,
    );

    assert.equal(outcome.outcome, "cancelled");
    assert.equal(readFileSync(join(root, "exp.ipynb"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
