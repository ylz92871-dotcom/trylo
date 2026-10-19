import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { createRunExecution } from "./run-execution-wiring.js";

test("host shell isolation is an explicit closed CLI choice, absent by default", () => {
  const explicit = parseArgs(["run", "--shell-isolation", "host", "hello"]);
  assert.equal(explicit.kind, "run");
  if (explicit.kind === "run") assert.equal(Reflect.get(explicit.options, "shellIsolation"), "host");
  const implicit = parseArgs(["run", "hello"]);
  assert.equal(implicit.kind, "run");
  if (implicit.kind === "run") assert.equal("shellIsolation" in implicit.options, false);
  assert.equal(parseArgs(["run", "--shell-isolation", "invalid", "hello"]).kind, "error");
});

test("explicit host execution writes as the caller without requiring the Windows sandbox account", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-host-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { homeDir: root, env: { TRYLO_HOME: path.join(root, "state") },
    platform: "win32" as const, shellIsolation: "host" as const };
  const execution = createRunExecution(root, options);
  t.after(() => execution.close());
  const target = path.join(root, "effect.txt");
  const result = await execution.spawner({ argv: [process.execPath, "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'approved effect')", target],
    cwd: root, timeoutMs: 10000, signal: new AbortController().signal,
    maxOutputBytes: 8192, maxOutputLines: 100 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readFileSync(target, "utf8"), "approved effect");
});
