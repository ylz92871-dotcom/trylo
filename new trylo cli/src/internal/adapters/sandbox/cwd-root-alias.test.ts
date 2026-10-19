import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planWorkingDirectory } from "./command.js";

test("an absolute workspace root cwd is the same admitted directory as dot", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-cwd-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(planWorkingDirectory(root, root), planWorkingDirectory(root, "."));
  assert.deepEqual(planWorkingDirectory(root, root + path.sep), planWorkingDirectory(root, "."));
  const subdir = path.join(root, "src");
  mkdirSync(subdir);
  assert.deepEqual(planWorkingDirectory(root, subdir), planWorkingDirectory(root, "src"));
  assert.equal(planWorkingDirectory(root, "../other").ok, false);
  assert.equal(planWorkingDirectory(root, root + "-sibling").ok, false);
});

test("root-like traversal strings do not become aliases", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-cwd-traversal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(planWorkingDirectory(root, root + path.sep + "src" + path.sep + "..").ok, false);
  assert.equal(planWorkingDirectory(root, root + path.sep + "..").ok, false);
});
