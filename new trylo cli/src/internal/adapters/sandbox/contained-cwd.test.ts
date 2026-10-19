import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planWorkingDirectory } from "./command.js";

test("an absolute contained cwd is an alias of the same workspace subdirectory", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-contained-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src"));
  assert.deepEqual(planWorkingDirectory(root, path.join(root, "src")), planWorkingDirectory(root, "src"));
  assert.equal(planWorkingDirectory(root, root + "-sibling").ok, false);
  assert.equal(planWorkingDirectory(root, "../outside").ok, false);
});
