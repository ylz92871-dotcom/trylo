import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../../../protocol/envelope.js";
import { createReadOnlyTools } from "./index.js";
import { DEFAULT_READ_ONLY_LIMITS } from "./limits.js";
import { createNodeFileSystemReader } from "./node-fs.js";
import { applyLimits } from "./read-file.js";

test("B1 navigation filters before content budget and returns directly readable scoped hits", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-navigation-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.log"), "needle in logs");
  writeFileSync(join(root, "src", "b.log"), "needle in logs");
  writeFileSync(join(root, "src", "target.ts"), "export const needle = 3;\n");
  const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader(), limits: { ...DEFAULT_READ_ONLY_LIMITS, maxSearchFiles: 1 } });
  const call = (name: string, args: JsonObject) => tools.execute({ name, arguments: args, toolCallId: "nav" }, new AbortController().signal);
  const search = await call("search_text", { pattern: "needle", path: "src", include: ["src/**/*.ts"] });

  assert.equal(search.outcome, "result");

  if (search.outcome !== "result") return;

  assert.equal(search.value.filesScanned, 1);
  assert.equal(search.value.truncated, false);
  assert.deepEqual(search.value.hits, [{ path: "src/target.ts", line: 1, text: "export const needle = 3;" }]);
  assert.match(search.output, /src\/target.ts:1:/);
  const glob = await call("glob_files", { pattern: "*.ts", path: "src" });

  assert.equal(glob.outcome, "result");

  if (glob.outcome !== "result") return;

  assert.deepEqual(glob.value.matches, ["target.ts"], "legacy view keeps its matching base");
  assert.deepEqual(glob.value.paths, ["src/target.ts"]);
  const read = await call("read_file", { path: "src/target.ts" });

  assert.equal(read.outcome, "result");
});

test("B1 local gitignore works without Git and is shared by list/search/glob, not read permissions", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-ignore-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), "*.log\nsrc/*.js\n");
  writeFileSync(join(root, "src", ".gitignore"), "!keep.js\n");

  for (const name of ["keep.js", "skip.js", "trace.log"]) writeFileSync(join(root, "src", name), "needle");

  const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
  const call = (name: string, args: JsonObject) => tools.execute({ name, arguments: args, toolCallId: "ignore" }, new AbortController().signal);
  const listed = await call("list_files", { path: "src" });

  assert.equal(listed.outcome, "result");

  if (listed.outcome !== "result") return;

  assert.equal((listed.value.entries as readonly string[]).includes("src/skip.js"), false);
  const found = await call("glob_files", { pattern: "*.js", path: "src" });

  assert.equal(found.outcome, "result");

  if (found.outcome !== "result") return;

  assert.deepEqual(found.value.paths, ["src/keep.js"]);
  const searched = await call("search_text", { pattern: "needle", path: "src" });

  assert.equal(searched.outcome, "result");

  if (searched.outcome !== "result") return;

  assert.equal(searched.value.matchCount, 1);
  assert.equal((await call("read_file", { path: "src/skip.js" })).outcome, "result");
});

test("B1 default read retains legacy content and exposes its nextOffset to the model", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-read-contract-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = Array.from({ length: 2600 }, (_, i) => `const item${i} = ${i};`).join("\r\n") + "\r\n";

  writeFileSync(join(root, "large.ts"), source);
  const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
  const result = await tools.execute({ name: "read_file", arguments: { path: "large.ts" }, toolCallId: "large" }, new AbortController().signal);

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.equal(result.value.content, applyLimits(source, DEFAULT_READ_ONLY_LIMITS).text);
  assert.equal(JSON.parse(result.output.split("\n")[0] ?? "").nextOffset, 2000);
  assert.equal(result.value.nextOffset, 2000);
});
