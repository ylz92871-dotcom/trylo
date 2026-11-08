import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("a runtime identity probe does not load unrelated management command runtimes", () => {
  const coverage = mkdtempSync(path.join(tmpdir(), "trylo-startup-load-"));
  const entry = fileURLToPath(new URL("./main.js", import.meta.url));
  const run = spawnSync(process.execPath, [entry, "--version"], {
    env: { ...process.env, NODE_V8_COVERAGE: coverage, TRYLO_HOME: coverage, USERPROFILE: coverage, HOME: coverage },
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });

  assert.equal(run.status, 0, run.stderr);
  const urls = readdirSync(coverage).flatMap((name) => {
    const report = JSON.parse(
      readFileSync(path.join(coverage, name), "utf8"),
    ) as { result: { url: string }[] };
    return report.result.map((item) => item.url);
  });

  for (const module of [
    "family-entries.js",
    "commands-auth.js",
    "commands-mcp.js",
    "commands-providers.js",
    "tool-production-service.js",
    "production-verifier.js",
    "npm-production-verifier.js",
  ]) {
    assert.equal(
      urls.some((url) => url.endsWith("/" + module)),
      false,
      `${module} must load only when its command is selected`,
    );
  }
});
