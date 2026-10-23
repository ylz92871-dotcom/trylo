import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNodeSpawner } from "../../internal/adapters/tools/mutating/shell-spawn.js";

const entry = fileURLToPath(new URL("./windows-pipeline.js", import.meta.url));
test("the restricted runner also preserves a single admitted command and its exit code", () => {
  const value = "one 中文 & literal";
  const stages = [{ kind: "direct", argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);process.exitCode=3", value] }];
  const result = spawnSync(process.execPath, [entry, JSON.stringify(stages)], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, value);
});
test("restricted pipeline runner preserves literal argv, UTF-8 bytes and final-stage exit", () => {
  const value = "中文_%!&^\\tail";
  const stages = [
    { kind: "direct", argv: [process.execPath, "-e", "process.stderr.write('first-error');process.stdout.write(process.argv[1]);process.exitCode=7", value] },
    { kind: "direct", argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(0));process.stderr.write('last-error');process.exitCode=3"] },
  ];
  const result = spawnSync(process.execPath, [entry, JSON.stringify(stages)], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, value);
  assert.match(result.stderr, /first-error/);
  assert.match(result.stderr, /last-error/);
});

test("malformed private pipeline payload fails before starting a command", () => {
  const result = spawnSync(process.execPath, [entry, '[{"kind":"direct","argv":[12]}]'], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /isolation_pipeline_invalid/);
});

test("a receiver can finish early while the finite producer drains", async () => {
  const stages = [
    { kind: "direct", argv: [process.execPath, "-e", "process.stdout.write(Buffer.alloc(8*1024*1024,120))"] },
    { kind: "direct", argv: [process.execPath, "-e", "process.stdin.once('data',()=>{process.stdout.write('EARLY');process.stdin.destroy()})"] },
  ];
  const result = await createNodeSpawner()({ argv: [process.execPath, entry, JSON.stringify(stages)], cwd: process.cwd(), timeoutMs: 5000, signal: new AbortController().signal, maxOutputBytes: 1024, maxOutputLines: 10 });
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "EARLY");
});

test("invalid NUL argv is rejected before any pipeline stage starts", () => {
  const stages = [{kind:"direct",argv:[process.execPath,"-e","process.stdout.write('STARTED')"]},{kind:"direct",argv:[process.execPath,"\0"]}];
  const result = spawnSync(process.execPath, [entry, JSON.stringify(stages)], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status,1);
  assert.equal(result.stdout,"");
  assert.match(result.stderr,/isolation_pipeline_invalid/);
});
