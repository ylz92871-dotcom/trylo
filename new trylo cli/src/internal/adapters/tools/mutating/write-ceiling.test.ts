import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";

test("unified edit patches cannot grow the result beyond the declared write ceiling", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-edit-ceiling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.txt"), "old\n");
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root, maxWriteBytes: 8 }) });
  const result = await tools.execute({ name: "edit_file", toolCallId: "ceiling", arguments: {
    path: "source.txt", patch: "@@ -1 +1 @@\n-old\n+" + "x".repeat(100),
  } }, new AbortController().signal);
  assert.equal(result.outcome, "error", JSON.stringify(result));
  if (result.outcome === "error") assert.equal(result.code, "write_too_large");
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "old\n");
});

test("notebook edits enforce the whole serialized file ceiling before replacing any bytes", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-notebook-ceiling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initial = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { id: "c1", cell_type: "markdown", metadata: {}, source: "old" },
  ] });
  writeFileSync(join(root, "book.ipynb"), initial);
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root, maxWriteBytes: 256 }) });
  const result = await tools.execute({ name: "notebook_edit", toolCallId: "ceiling", arguments: {
    path: "book.ipynb", cell_id: "c1", new_source: "x".repeat(1024),
  } }, new AbortController().signal);
  assert.equal(result.outcome, "error", JSON.stringify(result));
  if (result.outcome === "error") assert.equal(result.code, "write_too_large");
  assert.equal(readFileSync(join(root, "book.ipynb"), "utf8"), initial);
});
