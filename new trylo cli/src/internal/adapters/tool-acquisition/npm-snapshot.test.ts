import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { IsolationOutcome } from "../../ports/isolation.js";
import { runNpmSnapshot } from "./npm-snapshot.js";

test("every terminal invocation removes private inputs and raw outputs instead of creating learning records", async t => {
  const base = path.resolve("Temp/npm-snapshot-storage-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base); t.after(() => rm(root, { recursive: true, force: true }));
  const cases: readonly IsolationOutcome[] = [
    { outcome: "completed", stdout: '{"kind":"value","value":7}', stderr: "", exitCode: 0, timedOut: false, backend: "windows-srt" },
    { outcome: "completed", stdout: "bad protocol", stderr: "TEST ONLY private diagnostics", exitCode: 0, timedOut: false, backend: "windows-srt" },
    { outcome: "cancelled" }, { outcome: "isolation_failed", code: "isolation_refused", message: "TEST ONLY" },
  ];
  for (const outcome of cases) {
    let invoked = false;
    const result = await runNpmSnapshot({ files: [{ path: "node_modules/test/index.cjs", body: Buffer.from("/* TEST ONLY never execute */") }],
      entrypoint: "node_modules/test/index.cjs", runtime: { profile: "confined_npm_cli_v1", bin: "test", entrypoint: "index.cjs" }, schema: {}, timeoutMs: 1000 },
    { argv: [], stdin: "TEST_ONLY_PRIVATE_INPUT" }, { scratchRoot: root, nodeExecutable: process.execPath, isolation: {
      probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "TEST ONLY filesystem contract, not native execution evidence" }),
      run: async request => { invoked = true; const input = JSON.parse(await readFile(path.join(request.cwd, "input.json"), "utf8")); assert.equal(input.input.stdin, "TEST_ONLY_PRIVATE_INPUT"); return outcome; },
    } }, new AbortController().signal);
    assert.ok(invoked); assert.deepEqual(await readdir(root), []);
    assert.equal(result.kind, outcome.outcome === "cancelled" ? "cancelled" : outcome.outcome === "isolation_failed" ? "unavailable" : outcome.stdout.startsWith("{") ? "value" : "protocol_error");
  }
});
