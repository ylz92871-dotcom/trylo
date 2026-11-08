import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";

test("LF replacement input matches CRLF file lines without changing BOM or surrounding endings", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-edit-endings-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "index.html");

  writeFileSync(file, "\uFEFFbefore\r\none\r\ntwo\r\nafter\n");
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
  const result = await tools.execute({ name: "edit_file", toolCallId: "endings", arguments: { path: "index.html", old_string: "one\ntwo\n", new_string: "ONE\nTWO\nTHREE\n" } }, new AbortController().signal);

  assert.equal(result.outcome, "result", JSON.stringify(result));
  assert.equal(readFileSync(file, "utf8"), "\uFEFFbefore\r\nONE\r\nTWO\r\nTHREE\r\nafter\n");
});

test("line-ending normalization still refuses duplicate content and real whitespace differences", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-edit-ending-refuse-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "index.html"), source = "one\r\ntwo\r\none\r\ntwo\r\n";

  writeFileSync(file, source);
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });

  for (const [old_string, code] of [["one\ntwo\n", "edit_match_ambiguous"], ["one \ntwo\n", "edit_match_not_found"]]) {
    const result = await tools.execute({ name: "edit_file", toolCallId: "refuse", arguments: { path: "index.html", old_string: old_string!, new_string: "changed\n" } }, new AbortController().signal);
    assert.equal(result.outcome, "error");
    if (result.outcome === "error") assert.equal(result.code, code);
    assert.equal(readFileSync(file, "utf8"), source);
  }
});
