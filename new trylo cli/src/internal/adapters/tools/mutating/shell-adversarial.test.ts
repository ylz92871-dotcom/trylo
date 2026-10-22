import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeSpawner } from "./shell-spawn.js";

test("a pre-cancelled spawn cannot start either a single process or a pipeline", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-abort-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "must-not-exist.txt");
  const argv = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`];
  const controller = new AbortController();
  controller.abort();
  for (const pipe of [false, true]) {
    const result = await createNodeSpawner()({ argv, cwd: root, timeoutMs: 2000, signal: controller.signal, maxOutputBytes: 1024, maxOutputLines: 20,
      ...(pipe ? { pipeTo: [{ argv, shape: { kind: "direct" as const, argv } }] } : {}) });
    assert.equal(result.aborted, true);
    assert.equal(existsSync(marker), false, "cancelled work must have no process side effects");
  }
});
