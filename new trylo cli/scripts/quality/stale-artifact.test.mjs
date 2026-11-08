import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverRunnableTests,
  isStaleDistTest,
  listDistTestFiles,
} from "./discover-tests.mjs";

test("deleted source tests are not selected even if old dist js remains", () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-stale-"));
  const srcRoot = join(root, "src");
  const distRoot = join(root, "dist");

  mkdirSync(join(srcRoot, "internal", "protocol"), { recursive: true });
  mkdirSync(join(distRoot, "internal", "protocol"), { recursive: true });
  writeFileSync(join(srcRoot, "internal", "protocol", "live.test.ts"), "export {}\n");
  writeFileSync(join(distRoot, "internal", "protocol", "live.test.js"), "export {}\n");
  writeFileSync(join(distRoot, "internal", "protocol", "ghost.test.js"), "export {}\n");
  writeFileSync(join(distRoot, "internal", "protocol", "test.js"), "export {}\n");

  const runnable = discoverRunnableTests(srcRoot, distRoot);

  assert.equal(runnable.length, 1);
  assert.equal(runnable[0]?.srcFile.endsWith("live.test.ts"), true);

  const distTests = listDistTestFiles(distRoot);
  const stale = distTests.filter((file) => isStaleDistTest(file, srcRoot, distRoot));

  assert.equal(
    stale.some((file) => file.endsWith("ghost.test.js")),
    true,
  );
  assert.equal(
    stale.some((file) => file.endsWith("live.test.js")),
    false,
  );
  assert.equal(
    runnable.some((item) => item.distFile.endsWith("ghost.test.js")),
    false,
  );
  assert.equal(
    runnable.some((item) => /(?:^|[\\/])test\.js$/.test(item.distFile)),
    false,
  );
});
