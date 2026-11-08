import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";

/**
 * `list_files` exists so a model can find a project's entry points without
 * guessing a path or shelling out for `ls` (D3). The contract that matters is
 * that it *reads like a listing*: one level, workspace-relative, directories
 * marked, ordering stable, and nothing hidden silently — an excluded name is
 * reported, never dropped, because a listing that swallowed `node_modules`
 * would look like a project with no dependencies.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-list-"));
}

function toolsFor(root: string) {
  return createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
}

async function list(root: string, args: JsonObject) {
  const outcome = await toolsFor(root).execute(
    { toolCallId: "c1", name: "list_files", arguments: args },
    new AbortController().signal,
  );
  return outcome;
}

test("one level, directories first, workspace-relative, excluded names counted", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "zulu"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "alpha", "inner.txt"), "x");
    writeFileSync(join(root, "m1.txt"), "x");
    writeFileSync(join(root, "m2.txt"), "x");

    const outcome = await list(root, {});

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    assert.equal(outcome.output, "alpha/\nzulu/\nm1.txt\nm2.txt");
    assert.equal(outcome.value["hiddenByDefault"], 1);
    assert.equal(outcome.value["truncated"], false);
    // One level only: the child of `alpha` is not in this listing.
    assert.equal(outcome.output.includes("inner.txt"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unnamed or blank directory means the workspace root", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "only.txt"), "x");
    // All three are the same request as far as a caller is concerned, and the
    // blank one used to be the only one that failed.
    for (const args of [{}, { path: "." }, { path: "" }, { path: "  " }]) {
      const outcome = await list(root, args);
      assert.equal(outcome.outcome, "result", JSON.stringify(args));
      if (outcome.outcome === "result") {
        assert.equal(outcome.output, "only.txt", JSON.stringify(args));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested directory is listed with its own prefix, ready for read_file", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "alpha", "inner.txt"), "x");

    const outcome = await list(root, { path: "alpha" });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    assert.equal(outcome.output, "alpha/inner.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a listing past its cap says it was cut instead of ending quietly", async () => {
  const root = tempRoot();
  try {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      writeFileSync(join(root, name), "x");
    }

    const tools = createReadOnlyTools({
      workspaceRoot: root,
      reader: createNodeFileSystemReader(),
      limits: {
        maxBytes: 65_536,
        maxLines: 2_000,
        maxSearchFiles: 500,
        maxSearchMatches: 100,
        maxSearchDepth: 6,
        maxListEntries: 2,
      },
    });
    const outcome = await tools.execute(
      { toolCallId: "c1", name: "list_files", arguments: {} },
      new AbortController().signal,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    assert.equal(outcome.output, "a.txt\nb.txt");
    assert.equal(outcome.value["truncated"], true);
    assert.equal(outcome.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listing outside the workspace is refused like any other path", async () => {
  const root = tempRoot();
  try {
    const outcome = await list(root, { path: "../" });
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "path_outside_workspace");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that is not there is a list error, not an empty listing", async () => {
  const root = tempRoot();
  try {
    const outcome = await list(root, { path: "nope" });

    // An empty listing would read as "the project has nothing here", which is a
    // different answer from "that directory does not exist".
    assert.equal(outcome.outcome, "error");

    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "list_failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
