import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import type { ToolCallRequest } from "../../../ports/tools.js";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";
import { DEFAULT_READ_ONLY_LIMITS, type ReadOnlyToolLimits } from "./limits.js";
import { executeReadNotebook, READ_NOTEBOOK_TOOL } from "./notebook-read.js";

/**
 * WP13.2 (L12) green cover through the real read-only ToolPort: the model sees
 * cells, not raw JSON; oversize notebooks refuse with a cell_id resume hint;
 * corrupt files refuse and — this being a read-only tool — trivially leave
 * the file alone, which the corrupt case asserts byte for byte anyway.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-notebook-read-"));
}

function callFor(args: JsonObject): ToolCallRequest {
  return { toolCallId: "c1", name: READ_NOTEBOOK_TOOL, arguments: args };
}

function toolsFor(root: string, limits?: ReadOnlyToolLimits) {
  return createReadOnlyTools({
    workspaceRoot: root,
    reader: createNodeFileSystemReader(),
    ...(limits === undefined ? {} : { limits }),
  });
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

test("cell-aware read: cell views in value, cell markup in output, no raw JSON shape", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    const outcome = await toolsFor(root).execute(callFor({ path: "exp.ipynb" }), SIGNAL);

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.value.cellCount, 2);
      const cells = outcome.value.cells as ReadonlyArray<JsonObject>;
      assert.equal(cells[0]?.["cell_id"], "a1");
      assert.ok(outcome.output.includes('<cell id="a1">x = 1</cell>'));
      assert.ok(outcome.output.includes("<cell_type>markdown</cell_type>"));
      assert.ok(!outcome.output.includes('"execution_count"'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-cell read by id; unknown ids refuse", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    const tools = toolsFor(root);
    const single = await tools.execute(callFor({ path: "exp.ipynb", cell_id: "m1" }), SIGNAL);

    assert.equal(single.outcome, "result");

    if (single.outcome === "result") {
      assert.equal(single.value.cellCount, 2);
      assert.equal((single.value.cells as ReadonlyArray<JsonObject>).length, 1);
      assert.ok(single.output.includes("# title"));
      assert.ok(!single.output.includes("x = 1"));
    }

    const missing = await tools.execute(callFor({ path: "exp.ipynb", cell_id: "zzz" }), SIGNAL);

    assert.equal(missing.outcome, "error");

    if (missing.outcome === "error") {
      assert.equal(missing.code, "cell_not_found");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversize notebooks refuse with a cell_id hint instead of a silent prefix", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    const tiny: ReadOnlyToolLimits = { ...DEFAULT_READ_ONLY_LIMITS, maxBytes: 10 };
    const outcome = await toolsFor(root, tiny).execute(callFor({ path: "exp.ipynb" }), SIGNAL);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "notebook_too_large");
      assert.ok(outcome.message.includes("cell_id"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt notebooks refuse as invalid_notebook and stay byte-identical", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "bad.ipynb"), "{not json");
    const tools = toolsFor(root);
    const outcome = await tools.execute(callFor({ path: "bad.ipynb" }), SIGNAL);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "invalid_notebook");
    }

    assert.equal(readFileSync(join(root, "bad.ipynb"), "utf8"), "{not json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor cancel branches, called directly: pre-aborted and abort-during-read", async () => {
  // Same split as read_pdf: the dispatcher test below proves the ToolPort
  // answers cancelled; these pin the executor's own before-read check and its
  // read-catch mapping. Removing either branch fails its case.
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    const reader = createNodeFileSystemReader();
    const preAborted = new AbortController();

    preAborted.abort();
    assert.equal(
      (
        await executeReadNotebook(
          { workspaceRoot: root, reader },
          DEFAULT_READ_ONLY_LIMITS,
          callFor({ path: "exp.ipynb" }),
          preAborted.signal,
        )
      ).outcome,
      "cancelled",
    );
    const midFlight = new AbortController();
    const abortingReader = {
      ...createNodeFileSystemReader(),
      readFileUtf8: (_absolutePath: string, _signal: AbortSignal): Promise<string> => {
        midFlight.abort();
        throw new Error("boom");
      },
    };

    assert.equal(
      (
        await executeReadNotebook(
          { workspaceRoot: root, reader: abortingReader },
          DEFAULT_READ_ONLY_LIMITS,
          callFor({ path: "exp.ipynb" }),
          midFlight.signal,
        )
      ).outcome,
      "cancelled",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-ipynb paths, escapes, missing files, and cancellation refuse honestly", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exp.ipynb"), sample());
    const tools = toolsFor(root);
    const notNotebook = await tools.execute(callFor({ path: "notes.txt" }), SIGNAL);

    assert.equal(notNotebook.outcome, "error");

    if (notNotebook.outcome === "error") {
      assert.equal(notNotebook.code, "invalid_arguments");
    }

    if (notNotebook.outcome === "error") {
      assert.equal(notNotebook.code, "invalid_arguments");
    }

    const outside = await tools.execute(callFor({ path: "../escape.ipynb" }), SIGNAL);

    assert.equal(outside.outcome, "error");

    if (outside.outcome === "error") {
      assert.equal(outside.code, "path_outside_workspace");
    }

    const missing = await tools.execute(callFor({ path: "gone.ipynb" }), SIGNAL);

    assert.equal(missing.outcome, "error");

    if (missing.outcome === "error") {
      assert.equal(missing.code, "read_failed");
    }

    const aborted = new AbortController();

    aborted.abort();
    assert.equal((await tools.execute(callFor({ path: "exp.ipynb" }), aborted.signal)).outcome, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
