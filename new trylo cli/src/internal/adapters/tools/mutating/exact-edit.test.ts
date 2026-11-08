import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";

test("edit_file replaces one exact string through the production sandbox and preserves surrounding BOM and endings", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-exact-edit-"));
  try {
    writeFileSync(join(root, "source.txt"), "\uFEFFone\r\ntwo\r\nthree\r\n");
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
    const result = await tools.execute({ toolCallId: "c", name: "edit_file", arguments: { path: "source.txt", old_string: "two", new_string: "changed" } }, new AbortController().signal);
    assert.equal(result.outcome, "result");
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "\uFEFFone\r\nchanged\r\nthree\r\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ambiguous and missing exact strings leave the original bytes unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-exact-refuse-"));
  try {
    const initial = "same\nsame\n";

    writeFileSync(join(root, "source.txt"), initial);
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });

    for (const [old_string, code] of [["same", "edit_match_ambiguous"], ["absent", "edit_match_not_found"]] as const) {
      const result = await tools.execute({ toolCallId: "c", name: "edit_file", arguments: { path: "source.txt", old_string, new_string: "changed" } }, new AbortController().signal);
      assert.equal(result.outcome, "error");
      if (result.outcome === "error") assert.equal(result.code, code);
      assert.equal(readFileSync(join(root, "source.txt"), "utf8"), initial);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact edits keep the workspace containment and declared write size boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-exact-boundary-"));
  try {
    writeFileSync(join(root, "source.txt"), "one");
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root, maxWriteBytes: 4 }) });
    const result = await tools.execute({ toolCallId: "c", name: "edit_file", arguments: { path: "source.txt", old_string: "one", new_string: "larger" } }, new AbortController().signal);

    assert.equal(result.outcome, "error");

    if (result.outcome === "error") assert.equal(result.code, "write_too_large");

    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "one");
    const grown = await tools.execute({ toolCallId: "c", name: "edit_file", arguments: { path: "source.txt", old_string: "o", new_string: "more" } }, new AbortController().signal);

    assert.equal(grown.outcome, "error");

    if (grown.outcome === "error") assert.equal(grown.code, "write_too_large");

    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "one");
    const escaped = await tools.execute({ toolCallId: "c", name: "edit_file", arguments: { path: "../outside.txt", old_string: "one", new_string: "two" } }, new AbortController().signal);

    assert.equal(escaped.outcome, "error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
