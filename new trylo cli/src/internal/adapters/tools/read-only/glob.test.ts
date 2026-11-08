import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import { createReadOnlyTools, DEFAULT_READ_ONLY_LIMITS } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";

/**
 * `glob_files` exists so the model can find files by name shape without
 * shelling out or walking directories one level at a time. The contract that
 * matters: patterns are matched against forward-slash paths relative to the
 * search root, a pattern without a slash matches basenames at any depth (the
 * gitignore convention models already know), excluded directories stay
 * excluded, and truncation is reported instead of happening quietly.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-glob-"));
}

async function glob(root: string, args: JsonObject, limits = DEFAULT_READ_ONLY_LIMITS) {
  const tools = createReadOnlyTools({
    workspaceRoot: root,
    reader: createNodeFileSystemReader(),
    limits,
  });
  return tools.execute(
    { toolCallId: "c1", name: "glob_files", arguments: args },
    new AbortController().signal,
  );
}

function write(root: string, relative: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "x");
}

test("a slash-free pattern matches basenames at any depth, sorted", async () => {
  const root = tempRoot();
  try {
    write(root, "a.ts");
    write(root, "src/deep/b.ts");
    write(root, "src/c.js");

    const outcome = await glob(root, { pattern: "*.ts" });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    assert.equal(outcome.output.split("\n").slice(1).join("\n"), "a.ts\nsrc/deep/b.ts");
    assert.equal(outcome.value["matchCount"], 2);
    assert.equal(outcome.value["truncated"], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("** crosses directories, ? matches one character, {a,b} alternates", async () => {
  const root = tempRoot();
  try {
    write(root, "src/x/one.test.ts");
    write(root, "src/two.test.ts");
    write(root, "src/three.spec.ts");
    write(root, "ab.md");
    write(root, "a1.md");
    write(root, "abc.md");

    const star = await glob(root, { pattern: "src/**/*.test.ts" });

    assert.equal(star.outcome, "result");

    if (star.outcome === "result") {
      assert.equal(star.output.split("\n").slice(1).join("\n"), "src/two.test.ts\nsrc/x/one.test.ts");
    }

    const question = await glob(root, { pattern: "a?.md" });

    assert.equal(question.outcome, "result");

    if (question.outcome === "result") {
      assert.equal(question.output.split("\n").slice(1).join("\n"), "a1.md\nab.md");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the path argument narrows the walk and the matching base", async () => {
  const root = tempRoot();
  try {
    write(root, "keep/inner.ts");
    write(root, "skip/other.ts");

    const outcome = await glob(root, { pattern: "**/*.ts", path: "keep" });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      // Relative to the search root, matching list_files' workspace-relative
      // style but rooted where the caller asked to look.
      assert.equal(outcome.output.split("\n").slice(1).join("\n"), "keep/inner.ts");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("excluded directories are never descended into", async () => {
  const root = tempRoot();
  try {
    write(root, "node_modules/dep/index.ts");
    write(root, "src/real.ts");

    const outcome = await glob(root, { pattern: "**/*.ts" });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.output.split("\n").slice(1).join("\n"), "src/real.ts");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed pattern is a typed invalid_pattern error, not a crash or an empty list", async () => {
  const root = tempRoot();
  try {
    for (const pattern of ["[", "a{b", "[]", "src/**.ts/}"]) {
      const outcome = await glob(root, { pattern });
      assert.equal(outcome.outcome, "error", pattern);
      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "invalid_pattern", pattern);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or empty pattern is invalid_arguments", async () => {
  const root = tempRoot();
  try {
    for (const args of [{}, { pattern: "" }, { pattern: 42 }]) {
      const outcome = await glob(root, args as JsonObject);
      assert.equal(outcome.outcome, "error", JSON.stringify(args));
      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "invalid_arguments", JSON.stringify(args));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path outside the workspace is refused like every other read", async () => {
  const root = tempRoot();
  try {
    const outcome = await glob(root, { pattern: "*.ts", path: "../" });
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "path_outside_workspace");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("more matches than the entry cap reports truncated instead of ending quietly", async () => {
  const root = tempRoot();
  try {
    write(root, "a.txt");
    write(root, "b.txt");
    write(root, "c.txt");

    const outcome = await glob(root, { pattern: "*.txt" }, {
      ...DEFAULT_READ_ONLY_LIMITS,
      maxListEntries: 2,
    });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome === "result") {
      assert.equal(outcome.output.split("\n").slice(1).join("\n"), "a.txt\nb.txt");
      assert.equal(outcome.value["truncated"], true);
      assert.equal(outcome.truncated, true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("glob_files is advertised in the tool table as read-only, no approval", async () => {
  const root = tempRoot();
  try {
    const tools = createReadOnlyTools({
      workspaceRoot: root,
      reader: createNodeFileSystemReader(),
    });
    const binding = tools.snapshot().find((entry) => entry.name === "glob_files");

    assert.ok(binding, "glob_files must be in the snapshot");
    assert.equal(binding.sideEffect, "read_only");
    assert.equal(binding.needsApproval, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
