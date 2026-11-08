import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";

/**
 * `search_text` grew a regex mode. The contract that matters: the default is
 * still literal (a pattern that looks like a regex must not silently change
 * meaning for existing callers), a broken regex is a typed `invalid_pattern`
 * error the model can act on, and `ignoreCase` works in both modes.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-grep-"));
}

async function search(root: string, args: JsonObject) {
  const tools = createReadOnlyTools({
    workspaceRoot: root,
    reader: createNodeFileSystemReader(),
  });
  return tools.execute(
    { toolCallId: "c1", name: "search_text", arguments: args },
    new AbortController().signal,
  );
}

function setup(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "code.ts"), "const abc = 1;\nERROR: Failed login\n");
  writeFileSync(join(root, "notes.txt"), "literal a.c only\n");
}

test("the default mode stays literal: regex metacharacters are not special", async () => {
  const root = tempRoot();
  try {
    setup(root);
    const outcome = await search(root, { pattern: "a.c" });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    // Only notes.txt contains the literal "a.c"; src/code.ts has "abc".
    assert.equal(outcome.value["matchCount"], 1);
    assert.ok(String(outcome.value["matches"]).includes("notes.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regex mode matches by pattern meaning, with line numbers", async () => {
  const root = tempRoot();
  try {
    setup(root);
    const outcome = await search(root, { pattern: "a.c", mode: "regex" });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    assert.equal(outcome.value["matchCount"], 2);
    const matches = outcome.value["matches"] as ReadonlyArray<string>;

    assert.ok(matches.some((line) => line.includes("code.ts:1:")));
    assert.ok(matches.some((line) => line.includes("notes.txt:1:")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("alternation and anchors work in regex mode", async () => {
  const root = tempRoot();
  try {
    setup(root);
    const outcome = await search(root, { pattern: "^ERROR:", mode: "regex" });

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") {
      return;
    }

    assert.equal(outcome.value["matchCount"], 1);
    assert.ok(String(outcome.value["matches"]).includes("Failed login"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignoreCase applies to both regex and literal modes", async () => {
  const root = tempRoot();
  try {
    setup(root);
    const regexOutcome = await search(root, { pattern: "failed", mode: "regex", ignoreCase: true });

    assert.equal(regexOutcome.outcome, "result");

    if (regexOutcome.outcome === "result") {
      assert.equal(regexOutcome.value["matchCount"], 1);
    }

    const literalOutcome = await search(root, { pattern: "LITERAL", ignoreCase: true });

    assert.equal(literalOutcome.outcome, "result");

    if (literalOutcome.outcome === "result") {
      assert.equal(literalOutcome.value["matchCount"], 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken regex is a typed invalid_pattern error naming the reason", async () => {
  const root = tempRoot();
  try {
    setup(root);
    for (const pattern of ["(", "[a", "a{2,1}"]) {
      const outcome = await search(root, { pattern, mode: "regex" });
      assert.equal(outcome.outcome, "error", pattern);
      if (outcome.outcome === "error") {
        assert.equal(outcome.code, "invalid_pattern", pattern);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown mode is invalid_arguments, not a silent fallback", async () => {
  const root = tempRoot();
  try {
    setup(root);
    const outcome = await search(root, { pattern: "abc", mode: "fuzzy" });
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.equal(outcome.code, "invalid_arguments");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
