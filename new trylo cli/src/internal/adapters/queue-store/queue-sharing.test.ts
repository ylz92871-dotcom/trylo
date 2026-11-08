import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rewriteQueuedFile } from "./queue-file.js";

test("a transient sharing denial preserves the old queue until the atomic replacement succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-sharing-"));
  const file = join(root, "queue.ndjson");
  let attempts = 0;

  try {
    writeFileSync(file, "old\n");
    const result = await rewriteQueuedFile(file, "new\n", {
      wait: async () => {},
      replace: async (from, to) => {
        attempts += 1;
        assert.equal(readFileSync(file, "utf8"), "old\n");
        if (attempts < 3) throw Object.assign(new Error("sharing denial"), { code: "EPERM" });
        await rename(from, to);
      },
    });

    assert.equal(result, true);
    assert.equal(attempts, 3);
    assert.equal(readFileSync(file, "utf8"), "new\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [code, expectedAttempts] of [["EACCES", 4], ["ENOSPC", 1]] as const) {
  test(`a permanent ${code} fails within the limit and keeps the old queue`, async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-denied-"));
    const file = join(root, "queue.ndjson");
    let attempts = 0;

    try {
      writeFileSync(file, "old\n");
      assert.equal(await rewriteQueuedFile(file, "new\n", {
        wait: async () => {},
        replace: async () => {
          attempts += 1;
          throw Object.assign(new Error("denied"), { code });
        },
      }), false);
      assert.equal(attempts, expectedAttempts);
      assert.equal(readFileSync(file, "utf8"), "old\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
