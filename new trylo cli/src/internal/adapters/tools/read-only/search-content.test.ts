import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeFileSystemReader } from "./node-fs.js";
import { readSearchContent, searchSnippet } from "./search-content.js";

test("bounded Node text reads distinguish the exact byte boundary from oversize and obey cancellation", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-bounded-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "text.txt");
  writeFileSync(target, "中文");
  const reader = createNodeFileSystemReader();
  assert.ok(reader.readFileUtf8Bounded);
  assert.equal(await reader.readFileUtf8Bounded(target, 6, new AbortController().signal), "中文");
  assert.equal(await reader.readFileUtf8Bounded(target, 5, new AbortController().signal), undefined);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.readFileUtf8Bounded(target, 6, controller.signal), { name: "AbortError" });
});

test("a file growing after the size check cannot leak its oversized content into search", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-search-growth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "text.txt");
  writeFileSync(target, "needle".repeat(100));
  const reader = { ...createNodeFileSystemReader(), statBytes: async () => 1 };
  assert.deepEqual(await readSearchContent(reader, target, 32, new AbortController().signal), { kind: "large" });
});

test("readers without bounded IO retain compatibility and still enforce the search content ceiling", async () => {
  const result = await readSearchContent({ statBytes: async () => 1, readFileUtf8: async () => "中文", readDir: async () => [] }, "virtual.txt", 5, new AbortController().signal);
  assert.deepEqual(result, { kind: "large" });
});

test("search snippets keep astral characters intact at both boundaries", () => {
  for (let prefix = 0; prefix < 4; prefix += 1) {
    const source = "x".repeat(prefix) + "🌸".repeat(300) + "needle" + "🌸".repeat(300);
    const snippet = searchSnippet(source, source.indexOf("needle"));
    assert.match(snippet.text, /needle/);
    assert.equal(Buffer.from(snippet.text).toString("utf8"), snippet.text);
    assert.equal(snippet.text, source.slice((snippet.textStartColumn ?? 1) - 1, (snippet.textStartColumn ?? 1) - 1 + snippet.text.length));
  }
});
