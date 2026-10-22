import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadOnlyTools, DEFAULT_READ_ONLY_LIMITS } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";

test("search shows a late literal or regex match and declares the shortened line", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-search-quality-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "long.txt"), "x".repeat(900) + "needle" + "y".repeat(900));
  const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
  for (const mode of ["literal", "regex"]) {
    const result = await tools.execute({ toolCallId: mode, name: "search_text", arguments: { path: "long.txt", pattern: "needle", mode } }, new AbortController().signal);
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") return;
    assert.match(result.output, /needle/, "the returned source must contain the actual match");
    const hits = result.value.hits;
    assert.ok(Array.isArray(hits));
    const hit = hits[0];
    assert.ok(hit !== null && typeof hit === "object" && !Array.isArray(hit));
    assert.match(String(hit.text), /needle/);
    assert.ok(Number(hit.textStartColumn) > 1);
    assert.equal(result.truncated, true);
    assert.ok(String(result.value.truncationReasons).includes("line_truncated"));
  }
});

test("search skips binary contents with a visible count instead of fake text hits", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-search-binary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "data.bin"), Buffer.from("\0needle\0"));
  writeFileSync(join(root, "source.txt"), "needle");
  const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
  const result = await tools.execute({ toolCallId: "binary", name: "search_text", arguments: { pattern: "needle" } }, new AbortController().signal);
  assert.equal(result.outcome, "result");
  if (result.outcome !== "result") return;
  assert.equal(result.value.matchCount, 1);
  assert.equal(result.value.skippedBinaryFiles, 1);
  assert.doesNotMatch(result.output, /\0/);
});

test("search refuses oversized content before reading it and still finds ordinary files", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-search-large-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "large.txt"), "needle");
  writeFileSync(join(root, "small.txt"), "needle");
  const original = createNodeFileSystemReader();
  let largeReads = 0;
  const tools = createReadOnlyTools({ workspaceRoot: root, limits: DEFAULT_READ_ONLY_LIMITS, reader: {
    ...original,
    statBytes: async absolute => absolute.endsWith("large.txt") ? 2_000_000 : original.statBytes(absolute),
    readFileUtf8: async (absolute, signal) => {
      if (absolute.endsWith("large.txt")) largeReads += 1;
      return original.readFileUtf8(absolute, signal);
    },
  } });
  const result = await tools.execute({ toolCallId: "large", name: "search_text", arguments: { pattern: "needle" } }, new AbortController().signal);
  assert.equal(result.outcome, "result");
  if (result.outcome !== "result") return;
  assert.equal(largeReads, 0);
  assert.equal(result.value.matchCount, 1);
  assert.equal(result.value.skippedLargeFiles, 1);
  assert.ok(String(result.value.truncationReasons).includes("file_size_limit"));
});
