import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "../mutating/index.js";
import { resolveInsideWorkspace, resolveWriteTarget } from "./workspace.js";

test("workspace absolute paths support a real nested write and exact edit", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trylo-absolute-write-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "nested", "result.txt");
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
  const signal = new AbortController().signal;
  const write = await tools.execute({ toolCallId: "write", name: "write_file", arguments: { path: target, content: "before" } }, signal);
  assert.equal(write.outcome, "result", JSON.stringify(write));
  const edit = await tools.execute({ toolCallId: "edit", name: "edit_file", arguments: {
    path: target, old_string: "before", new_string: "after",
  } }, signal);
  assert.equal(edit.outcome, "result", JSON.stringify(edit));
  assert.equal(readFileSync(target, "utf8"), "after");
  assert.equal(resolveInsideWorkspace(root, target).ok, true);
});

test("absolute aliases never admit an outside workspace, device or redirected path", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trylo-absolute-root-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "trylo-absolute-outside-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  for (const path of [join(outside, "no.txt"), join(root, "..", "no.txt"), "\\\\.\\pipe\\untrusted", "\\\\?\\C:\\untrusted"]) {
    assert.equal(resolveWriteTarget(root, path).ok, false, path);
    assert.equal(resolveInsideWorkspace(root, path).ok, false, path);
  }
  symlinkSync(outside, join(root, "redirect"), "junction");
  assert.equal(resolveWriteTarget(root, join(root, "redirect", "no.txt")).ok, false);
  assert.equal(existsSync(join(outside, "no.txt")), false);
});
