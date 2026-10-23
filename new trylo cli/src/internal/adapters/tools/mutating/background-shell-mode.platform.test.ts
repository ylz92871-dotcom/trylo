import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { resolveShellMode } from "../../sandbox/shell-mode.js";
import type { ShellKind } from "../../sandbox/shell-detect.js";
import { createProcessSessionRegistry } from "../../process-session/session-registry.js";
import type { ProcessSessionEndReason } from "../../../ports/process-session.js";
import { createMutatingTools } from "./index.js";

const kinds: readonly ShellKind[] = process.platform === "win32" ? ["powershell", "cmd"] : ["sh"];
for (const kind of kinds) test(`background ${kind} preserves the interpreted command and its exit`, { timeout: 30_000 }, async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "trylo-shell-background-mode-"));
  const shellMode = resolveShellMode({ platform: process.platform, env: process.env, fileExists: existsSync }, kind);
  const sessions = createProcessSessionRegistry();
  try {
    assert.equal(shellMode.ok, true);
    const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot, shellMode }), shellMode, sessions });
    const command = kind === "powershell" ? "$v = 'spaced value'; [Console]::WriteLine($v); exit 7"
      : kind === "cmd" ? "echo spaced value & exit /b 7" : "printf '%s\\n' 'spaced value'; exit 7";
    const started = await tools.execute({ toolCallId: kind, name: "run_shell", arguments: { command, runInBackground: true } }, new AbortController().signal);
    assert.equal(started.outcome, "result");
    if (started.outcome !== "result") return;
    const id = started.value.sessionId;
    assert.equal(typeof id, "string");
    if (typeof id !== "string") return;
    let output = "";
    let terminal: ProcessSessionEndReason | undefined;
    for (let i = 0; i < 20; i++) {
      const result = await sessions.write({ sessionId: id, input: "", eof: false, yieldMs: 1000 });
      assert.ok(result.ok);
      output += result.read.output;
      if (result.read.end !== undefined) { terminal = result.read.end; break; }
    }
    assert.match(output, /spaced value/);
    assert.equal(terminal?.kind, "exited");
    if (terminal?.kind === "exited") assert.equal(terminal.exitCode, 7);
    assert.equal(sessions.list().sessions.length, 1);
  } finally {
    await sessions.shutdown();
    assert.ok(resolve(workspaceRoot).startsWith(resolve(tmpdir()) + sep));
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
