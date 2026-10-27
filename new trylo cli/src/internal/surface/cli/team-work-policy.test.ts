import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { constrainWorkMemberTool } from "./team-work-policy.js";

test("Work writes stay in the physical deliverable tree even under parent workspace authority", t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-work-scope-"));
  mkdirSync(path.join(root, ".trylo/out/job"), { recursive: true });
  mkdirSync(path.join(root, "src"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const call = (target: string, name = "write_file") => ({ name, toolCallId: "work-write", arguments: { path: target, content: "note" } });
  assert.equal(constrainWorkMemberTool("worker", root, call(".trylo/out/job/note.md")).ok, true);
  assert.equal(constrainWorkMemberTool("worker", root, call(path.join(root, ".trylo/out/job/note.md"), "edit_file")).ok, true);
  for (const target of ["src/main.ts", ".trylo/out/../../main.ts", "../outside.md", ".trylo/outside/note.md"]) {
    assert.equal(constrainWorkMemberTool("worker", root, call(target)).ok, false, target);
  }
  symlinkSync(path.join(root, "src"), path.join(root, ".trylo/out/redirect"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(constrainWorkMemberTool("worker", root, call(".trylo/out/redirect/main.ts")).ok, false);
});

test("Work policy refuses alternate mutation channels and keeps read-only roles read-only", () => {
  for (const name of ["run_shell", "apply_patch", "notebook_edit", "write_stdin", "stop_process"]) {
    assert.equal(constrainWorkMemberTool("worker", "D:/workspace", { name, toolCallId: "bypass", arguments: {} }).ok, false);
  }
  for (const role of ["person", "architect", "reviewer", "verifier"]) {
    assert.equal(constrainWorkMemberTool(role, "D:/workspace", { name: "write_file", toolCallId: "wrong-role",
      arguments: { path: ".trylo/out/verdict.md", content: "not a grant" } }).ok, false);
  }
  assert.equal(constrainWorkMemberTool("reviewer", "D:/workspace", { name: "read_file", toolCallId: "inspect",
    arguments: { path: "src/main.ts" } }).ok, true);
});
