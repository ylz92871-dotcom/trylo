import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";

test("workspace junction aliases keep ignore rules and directly readable relative paths", async t => {
  const base = mkdtempSync(join(tmpdir(), "trylo-alias-v2-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, "real");
  const alias = join(base, "alias");
  mkdirSync(real);
  writeFileSync(join(real, ".gitignore"), "hidden.txt\n");
  writeFileSync(join(real, "visible.txt"), "needle");
  writeFileSync(join(real, "hidden.txt"), "needle");
  symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  const tools = createReadOnlyTools({ workspaceRoot: alias, reader: createNodeFileSystemReader() });
  const call = (name: string, args: Record<string, string>) => tools.execute({ name, arguments: args, toolCallId: name }, new AbortController().signal);
  for (const name of ["search_text", "glob_files", "list_files", "find_files"]) {
    const result = await call(name, name === "search_text" ? { pattern: "needle" } : name === "glob_files" ? { pattern: "*.txt" } : name === "find_files" ? { query: "visible" } : {});
    assert.equal(result.outcome, "result", JSON.stringify(result));
    if (result.outcome !== "result") return;
    assert.doesNotMatch(result.output, /\.\.\//, name);
    assert.doesNotMatch(result.output, /hidden\.txt/, name);
    assert.match(result.output, /visible\.txt/, name);
  }
  const read = await call("read_file", { path: join(alias, "visible.txt") });
  assert.equal(read.outcome, "result");
  const imagePath = join(real, "image.png");
  writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64"));
  const image = await call("view_image", { path: "image.png" });
  assert.equal(image.outcome, "result", JSON.stringify(image));
  if (image.outcome === "result") assert.equal(image.images?.[0]?.path, realpathSync.native(imagePath), "actual aliases freeze media references to their physical target");
});

test("cancellation delivered while a reader resolves cannot turn into a successful file result", async () => {
  const controller = new AbortController();
  const tools = createReadOnlyTools({ workspaceRoot: tmpdir(), reader: {
    readFileUtf8: async () => { controller.abort(); return "late content"; },
    readDir: async () => [], statBytes: async () => 12,
  } });
  const result = await tools.execute({ name: "read_file", toolCallId: "cancel", arguments: { path: "late.txt" } }, controller.signal);
  assert.equal(result.outcome, "cancelled");
});
