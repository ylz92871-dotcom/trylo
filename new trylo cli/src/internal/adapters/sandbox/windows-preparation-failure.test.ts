import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWindowsShellBoundary } from "./windows-shell-boundary.js";
import { isolationCleanupError } from "./windows-isolation-error.js";

test("a cached preparation failure tells callers not to retry and preserves unresolved compensation on close", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-preparation-failure-"));
  let prepared = 0;
  const failure = isolationCleanupError("partial grant", new Error("fixture grant failed"), new Error("fixture cleanup failed"));

  try {
    const boundary = createWindowsShellBoundary(root, { LOCALAPPDATA: root, SystemRoot: "Z:\\missing-system" }, async () => {
      prepared += 1;
      throw failure;
    });
    for (let call = 0; call < 3; call += 1) await assert.rejects(boundary.wrap([process.execPath]), /Do not retry.*session/);
    assert.equal(prepared, 1);
    await assert.rejects(boundary.close(), error => error === failure);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
