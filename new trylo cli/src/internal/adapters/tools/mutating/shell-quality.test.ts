import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";
import type { ShellSpawner } from "./shell-spawn.js";
import { startBackgroundShell } from "./background-shell.js";
import { createProcessSessionRegistry } from "../../process-session/session-registry.js";

test("all sequential command output survives, including an earlier truncation flag", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-shell-quality-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const spawner: ShellSpawner = async () => {
    calls += 1;
    return { stdout: calls === 1 ? "FIRST-OUTPUT\n" : "SECOND-OUTPUT\n", stderr: calls === 1 ? "FIRST-WARNING\n" : "", exitCode: 0, timedOut: false, aborted: false, truncated: calls === 1 };
  };
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }), spawner });
  const result = await tools.execute({ toolCallId: "sequence", name: "run_shell", arguments: { command: "node -v", steps: ["node -v"] } }, new AbortController().signal);
  assert.equal(result.outcome, "result");
  if (result.outcome !== "result") return;
  assert.equal(calls, 2);
  assert.match(String(result.value.stdout), /FIRST-OUTPUT\nSECOND-OUTPUT/);
  assert.match(result.output, /FIRST-WARNING/);
  assert.equal(result.truncated, true);
});

test("a failed later command retains earlier diagnostic output and stops the chain", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-shell-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const spawner: ShellSpawner = async () => {
    calls += 1;
    return { stdout: calls === 1 ? "FIRST-DIAGNOSTIC\n" : "", stderr: calls === 2 ? "SECOND-ERROR\n" : "", exitCode: calls === 2 ? 7 : 0, timedOut: false, aborted: false, truncated: false };
  };
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: root }), spawner });
  const result = await tools.execute({ toolCallId: "failure", name: "run_shell", arguments: { command: "node -v", steps: ["node -v", "node -v"] } }, new AbortController().signal);
  assert.equal(result.outcome, "error");
  if (result.outcome !== "error") return;
  assert.equal(result.code, "shell_nonzero_exit");
  assert.equal(calls, 2);
  assert.match(result.message, /FIRST-DIAGNOSTIC/);
  assert.match(result.message, /SECOND-ERROR/);
});

test("background pipelines are refused before even the producer starts", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-background-pipe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = createProcessSessionRegistry();
  t.after(() => sessions.shutdown());
  const argv = [process.execPath, "-e", "process.stdout.write('producer')"];
  const result = await startBackgroundShell({ sessions, maxBufferBytes: 1024 }, {
    tool: "run_shell", executable: argv[0] ?? "node", argv, cwd: root,
    shape: { kind: "direct", argv },
    steps: [{ executable: argv[0] ?? "node", argv, shape: { kind: "direct", argv }, pipeTo: { executable: argv[0] ?? "node", argv, shape: { kind: "direct", argv } } }],
  });
  assert.equal(result.outcome, "error");
  if (result.outcome !== "error") return;
  assert.equal(result.code, "background_single_command_only");
  assert.equal(sessions.list().sessions.length, 0);
});
