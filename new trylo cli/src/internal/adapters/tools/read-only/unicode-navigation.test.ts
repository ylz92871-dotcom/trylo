import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";

test("Chinese workspaces search single files and return readable Unicode paths across navigation tools", async t => {
  const base = mkdtempSync(join(tmpdir(), "trylo-unicode-navigation-"));

  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "贪吃蛇 空格", "test");

  mkdirSync(join(root, "源码"), { recursive: true });
  writeFileSync(join(root, "src"), "a priority root may itself be a file\n");
  writeFileSync(join(root, "源码", "樱花 🌸.html"), ".stat-row { color: pink; }\r\nneedle 中文\r\n");

  for (const workspaceRoot of [root, root.replaceAll("\\", "/")]) {
    const tools = createReadOnlyTools({ workspaceRoot, reader: createNodeFileSystemReader() });
    const call = (name: string, args: Record<string, string>) => tools.execute({ name, arguments: args, toolCallId: "unicode" }, new AbortController().signal);

    for (const [name, args] of [
      ["search_text", { path: "源码/樱花 🌸.html", pattern: "needle" }],
      ["glob_files", { path: "源码/樱花 🌸.html", pattern: "*.html" }],
      ["find_files", { query: "樱花" }],
    ] as const) {
      const found = await call(name, args);

      assert.equal(found.outcome, "result", JSON.stringify(found));

      if (found.outcome !== "result") continue;

      assert.equal(found.value.matchCount, 1, `${name}: ${JSON.stringify(found)}`);
      const path = name === "search_text" ? (found.value.hits as { path: string }[])[0]!.path : (found.value.paths as string[])[0]!;

      assert.equal(path, "源码/樱花 🌸.html");
      assert.equal((await call("read_file", { path })).outcome, "result");
    }

    const missing = await call("glob_files", { path: "源码/樱花 🌸.html/absent", pattern: "*" });

    assert.equal(missing.outcome, "result");

    if (missing.outcome === "result") assert.equal(missing.value.matchCount, 0);

    const priority = await call("find_files", { query: "src" });

    assert.equal(priority.outcome, "result");

    if (priority.outcome === "result") assert.deepEqual(priority.value.paths, ["src"]);
  }
});

test("zero literal matches expose their actual mode without silently interpreting regex syntax", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-search-mode-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "index.html"), ".stat-row { color: pink; }\n");
  const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
  const call = (mode?: string) => tools.execute({ name: "search_text", toolCallId: "mode", arguments: { pattern: "stat-(row|value)", ...(mode === undefined ? {} : { mode }) } }, new AbortController().signal);
  const literal = await call();

  assert.equal(literal.outcome, "result");

  if (literal.outcome !== "result") return;

  assert.equal(literal.value.matchCount, 0);
  const metadata = JSON.parse(literal.output.split("\n")[0]!);

  assert.equal(metadata.mode, "literal");
  assert.match(metadata.hint, /mode.*regex/);
  const regex = await call("regex");

  assert.equal(regex.outcome, "result");

  if (regex.outcome === "result") assert.equal(regex.value.matchCount, 1);
});
