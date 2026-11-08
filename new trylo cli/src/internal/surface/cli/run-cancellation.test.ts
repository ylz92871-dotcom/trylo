import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";
import { handleRun, prepareRun } from "./run-command.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";

test("one-shot run observes interrupts and durably ends cancelled rather than completed", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-run-cancel-"));
  let interrupt: (() => void) | undefined;
  const output: string[] = [];
  const ctx: CliContext = {
    env: { TRYLO_HOME: root }, homeDir: root, cwd: root, nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory: () => true, readDir: () => [], writeFile: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => output.push(text), stderr: text => output.push(text), now: () => 0,
    newId: prefix => `${prefix}-cancel`,
    interrupts: { observe: handler => { interrupt = handler; }, exit: () => { throw new Error("second interrupt unused"); } },
    onRunEnvelope: () => interrupt?.(),
  };

  try {
    const parsed = parseArgs(["run", "--provider", "fixture", "--format", "stream-json", "--session", "wp28-cancel", "hello"]);

    assert.equal(parsed.kind, "run");

    if (parsed.kind !== "run") throw new Error("bad test arguments");

    const code = await handleRun(ctx, parsed.options, { stdout: ctx.stdout, stderr: ctx.stderr });

    assert.equal(code, 130);
    assert.ok(output.some(line => line.includes('"status":"cancelled"')));
    assert.ok(!output.some(line => line.includes('"status":"completed"')));
    const reopened = createNdjsonSessionStore({ path: join(root, "sessions", "wp28-cancel.ndjson") });
    const journal = await reopened.readRecords();

    assert(journal.ok);
    assert(journal.view.records.some(record => record.type === "terminal" && record.payload["reason"] === "cancelled"));
    assert.equal((await reopened.attach()).ok, true, "the cancelled run released its writer lock");
    await reopened.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid request options refuse before creating a session writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-prepare-refusal-"));
  const ctx: CliContext = {
    env: { TRYLO_HOME: root }, homeDir: root, cwd: root, nodeVersion: process.version, stdinIsTty: false,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory: () => true, readDir: () => [], writeFile: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-refusal`,
  };

  try {
    const parsed = parseArgs(["run", "--provider", "fixture", "--session", "invalid-options", "--system-prompt-file", join(root, "missing.txt"), "hello"]);
    assert.equal(parsed.kind, "run");
    if (parsed.kind !== "run") throw new Error("bad test arguments");
    const refused = await prepareRun(ctx, { options: parsed.options, sink: ctx, permissionMode: "non_interactive" });
    assert("exitCode" in refused);
    assert.equal(existsSync(join(root, "sessions", "invalid-options.ndjson")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
