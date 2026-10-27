import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRunExecution } from "./run-execution-wiring.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import type { ProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import type { ProcessSessionStart, ProcessSessionSnapshot } from "../../ports/process-session.js";
import { createPtySessionRegistry } from "../../adapters/process-session/pty-session.js";
import { resolvePtyHelper } from "../../adapters/process-session/pty-loader.js";

test("a cancelled background start cannot spawn after asynchronous preparation finishes", { timeout: 10000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-late-session-"));
  const execution = createRunExecution(root, { shellIsolation: "host", homeDir: path.join(root, ".profile"),
    env: { TRYLO_HOME: path.join(root, ".profile") } });
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const preparation = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await execution.close(); });
  const forward: (request: ProcessSessionStart, signal?: AbortSignal) => Promise<ProcessSessionSnapshot> = execution.sessions.start;
  const delayed: ProcessSessionRegistry = { ...execution.sessions,
    start: async (request, signal?: AbortSignal) => { entered(); await preparation; return forward(request, signal); } };
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
    sessions: delayed, spawner: execution.spawner });
  const pending = tools.execute({ name: "run_shell", toolCallId: "late-background", arguments: {
    command: `node -e ${JSON.stringify("setInterval(()=>{},1000)")}`, runInBackground: true } }, new AbortController().signal);
  await ready;
  await tools.cancel("late-background");
  release();
  const result = await pending;
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(execution.sessions.list().sessions, [], "no native command may appear after cancellation");
});

test("a closed execution refuses a new native process instead of orphaning it", { timeout: 10000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-closed-session-"));
  const execution = createRunExecution(root, { shellIsolation: "host", homeDir: path.join(root, ".profile"),
    env: { TRYLO_HOME: path.join(root, ".profile") } });
  t.after(async () => { await execution.close(); });
  await execution.close();
  await assert.rejects(execution.sessions.start({ id: "", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root, env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 65536 }), /session_registry_closed/);
  assert.deepEqual(execution.sessions.list().sessions, []);
});

test("a cancelled ConPTY admission never creates a terminal session", { timeout: 10000 }, async t => {
  const helper = resolvePtyHelper({ override: process.env.TRYLO_PTY_HELPER });
  if (!helper.ok) { t.skip(helper.message); return; }
  const root = mkdtempSync(path.join(tmpdir(), "trylo-cancelled-pty-"));
  const registry = createPtySessionRegistry({ helper });
  t.after(() => { registry.shutdown(); });
  const start: (request: ProcessSessionStart, signal?: AbortSignal) => Promise<ProcessSessionSnapshot> = registry.start;
  const cancel = new AbortController();
  cancel.abort("test_stop");
  await assert.rejects(start({ id: "", argv: [process.execPath, "-e", "process.exit(0)"], cwd: root,
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    tty: true, rows: 24, cols: 80, maxBufferBytes: 65536 }, cancel.signal), /session_start_cancelled/);
  assert.deepEqual(registry.list().sessions, []);
});

test("cancellation just after native spawn stops the newly created background command", { timeout: 10000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-cancel-started-session-"));
  const execution = createRunExecution(root, { shellIsolation: "host", homeDir: path.join(root, ".profile"),
    env: { TRYLO_HOME: path.join(root, ".profile") } });
  t.after(async () => { await execution.close(); });
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
    sessions: execution.sessions, spawner: execution.spawner });
  const pending = tools.execute({ name: "run_shell", toolCallId: "just-started", arguments: {
    command: `node -e ${JSON.stringify("setInterval(()=>{},1000)")}`, runInBackground: true } }, new AbortController().signal);
  assert.equal(execution.sessions.list().sessions.length, 1, "the race begins after real native spawn");
  await tools.cancel("just-started");
  assert.equal((await pending).outcome, "cancelled");
  assert.equal(execution.sessions.list().sessions.some(session => session.status === "running"), false);
});

test("a cancelled start with unconfirmed native stop reports unknown", { timeout: 10000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-unknown-started-session-"));
  const execution = createRunExecution(root, { shellIsolation: "host", homeDir: path.join(root, ".profile"),
    env: { TRYLO_HOME: path.join(root, ".profile") } });
  t.after(async () => { await execution.close(); });
  const sessions: ProcessSessionRegistry = { ...execution.sessions,
    stop: async () => ({ ok: false, code: "session_stop_failed", message: "injected native stop refusal" }) };
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
    sessions, spawner: execution.spawner });
  const pending = tools.execute({ name: "run_shell", toolCallId: "unconfirmed-start", arguments: {
    command: `node -e ${JSON.stringify("setInterval(()=>{},1000)")}`, runInBackground: true } }, new AbortController().signal);
  assert.equal(execution.sessions.list().sessions.length, 1);
  await tools.cancel("unconfirmed-start");
  assert.equal((await pending).outcome, "unknown");
  assert.equal(execution.sessions.list().sessions[0]?.status, "running");
});
