import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolOutcome } from "../../ports/tools.js";
import type { ProcessSessionEndReason } from "../../ports/process-session.js";
import { createWorkspaceSandbox } from "../sandbox/index.js";
import { createProcessSessionRegistry } from "../process-session/session-registry.js";
import { createBoundedBuffer } from "../process-session/output-buffer.js";
import { createProcessSessionTools } from "./mutating/process-session-tools.js";
import { createWorkspaceTools } from "./index.js";

/** Invoke the production catalog as its consumer: observe files, real child
 * input/output and the text the model receives, not just adapter internals. */
function fixture(t: TestContext, options: { readonly maxReadBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "trylo-tool-user-"));
  const sessions = createProcessSessionRegistry(options);
  const tools = createWorkspaceTools({ workspaceRoot: root, sessions, sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
  let id = 0;
  const use = (name: string, args: JsonObject) => tools.execute({ toolCallId: `user-${++id}`, name, arguments: args }, new AbortController().signal);
  t.after(async () => { await sessions.shutdown(); rmSync(root, { recursive: true, force: true }); });
  function script(name: string, content: string): string {
    mkdirSync(join(root, "任务 空间"), { recursive: true });
    writeFileSync(join(root, "任务 空间", name), content);
    return `node "任务 空间/${name}"`;
  }
  async function background(content: string): Promise<string> {
    const started = await use("run_shell", { command: script(`child-${id}.mjs`, content), runInBackground: true });
    assert.equal(started.outcome, "result", JSON.stringify(started));
    if (started.outcome !== "result") throw new Error("background did not start");
    return String(started.value.sessionId);
  }
  return { root, tools, sessions, use, script, background };
}

function result(outcome: ToolOutcome): Extract<ToolOutcome, { outcome: "result" }> {
  assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
  if (outcome.outcome !== "result") throw new Error("expected a tool result");
  return outcome;
}

async function finished(use: ReturnType<typeof fixture>["use"], sessionId: string) {
  let output = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const read = result(await use("write_stdin", { sessionId, yieldMs: 1000 }));
    output += String(read.value.output ?? "");
    if (read.value.status !== "running") return { read, output };
  }
  throw new Error("real child did not reach an observable terminal state");
}

test("user follows the background hint and polls with only sessionId", async t => {
  const f = fixture(t);
  const sessionId = await f.background("console.log('READY');");
  const read = result(await f.use("write_stdin", { sessionId }));
  const end = await finished(f.use, sessionId);
  assert.match(String(read.value.output) + end.output, /READY/);
});

test("user sends actual stdin without an optional yieldMs", async t => {
  const f = fixture(t);
  const sessionId = await f.background("process.stdin.once('data', data => { console.log('ECHO:' + data.toString()); process.stdin.destroy(); });");
  const typed = result(await f.use("write_stdin", { sessionId, chars: "用户输入\n" }));
  const end = await finished(f.use, sessionId);
  assert.match(String(typed.value.output) + end.output, /ECHO:用户输入/);
});

test("a failed background test reports its exit code in model text and structured result", async t => {
  const f = fixture(t);
  const sessionId = await f.background("console.log('tests finished with failures'); process.exitCode = 7;");
  const end = await finished(f.use, sessionId);
  assert.equal(end.read.value.exitCode, 7);
  assert.match(end.read.output, /exited[\s\S]*exit code:? 7/i);
  assert.match(end.output, /tests finished with failures/);
});

test("list_processes lets its text-only consumer distinguish a failed test", async t => {
  const f = fixture(t);
  const sessionId = await f.background("process.exitCode = 7;");
  await finished(f.use, sessionId);
  const listed = result(await f.use("list_processes", {}));
  assert.match(listed.output, /exited[\s\S]*exit code:? 7/i);
});

test("stop on an already ended test preserves its observed failure code", async t => {
  const f = fixture(t);
  const sessionId = await f.background("process.exitCode = 7;");
  await finished(f.use, sessionId);
  const stopped = result(await f.use("stop_process", { sessionId }));
  assert.equal(stopped.value.exitCode, 7);
  assert.match(stopped.output, /exit code:? 7/i);
});

for (const end of [
  { kind: "failed", code: "process_spawn_failed", message: "executable missing" },
  { kind: "lost", reason: "helper disconnected" },
] satisfies ProcessSessionEndReason[]) {
  test(`user sees why a ${end.kind} process ended even when its last output is nonempty`, async () => {
    const port = createProcessSessionTools({ supportsTty: false, list: () => ({ sessions: [] }),
      stop: async () => ({ ok: true, end }),
      write: async () => ({ ok: true, read: { id: "ps_test", output: "partial output", status: end.kind, end, truncated: false, bufferedBytes: 0 } }),
    });
    const read = result(await port.execute({ toolCallId: "terminal", name: "write_stdin", arguments: { sessionId: "ps_test", yieldMs: 1000 } }));
    assert.match(read.output, new RegExp(end.kind));
    assert.ok(read.output.includes(end.kind === "failed" ? end.message : end.reason));
    assert.equal(read.value.exitCode, undefined, "loss or spawn failure must never invent an exit code");
  });
}

test("a later spawn failure retains earlier workflow output and acknowledges work that ran", async t => {
  const f = fixture(t);
  const first = f.script("prepare.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync('prepared.txt', 'done'); console.log('PREPARED-REAL-DATA');");
  const last = f.script("forbidden.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync('must-not-run.txt', 'bad');");
  const outcome = await f.use("run_shell", { command: first, steps: ["trylo_missing_executable_90210", last] });
  assert.equal(existsSync(join(f.root, "prepared.txt")), true);
  assert.equal(existsSync(join(f.root, "must-not-run.txt")), false);
  assert.equal(outcome.outcome, "error");
  if (outcome.outcome !== "error") return;
  assert.equal(outcome.code, "shell_spawn_failed");
  assert.match(outcome.message, /PREPARED-REAL-DATA/);
  assert.match(outcome.message, /1.*(?:completed|already ran)/i);
});

test("control: user discovers, reads, edits and generates an artifact with quoted multilingual paths", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "配置 示例.txt"), "enabled=false\r\nlabel=中文\r\n");
  const found = result(await f.use("glob_files", { pattern: "*.txt" }));
  assert.match(found.output, /配置 示例.txt/);
  const read = result(await f.use("read_file", { path: "配置 示例.txt", offset: 0, limit: 1 }));
  assert.match(String(read.value.content), /enabled=false/);
  result(await f.use("edit_file", { path: "配置 示例.txt", old_string: "enabled=false", new_string: "enabled=true" }));
  assert.equal(readFileSync(join(f.root, "配置 示例.txt"), "utf8"), "enabled=true\r\nlabel=中文\r\n");
  const producer = f.script("report.mjs", "console.log(JSON.stringify({ actual: 42, label: '真实输出' }));");
  result(await f.use("run_shell", { command: producer, stdoutFile: "报告 结果.json" }));
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, "报告 结果.json"), "utf8")), { actual: 42, label: "真实输出" });
});

test("control: invalid explicit yield is refused without sending the requested stdin", async t => {
  const f = fixture(t);
  const sessionId = await f.background("process.stdin.on('data', () => console.log('UNEXPECTED-INPUT'));");
  const rejected = await f.use("write_stdin", { sessionId, chars: "not sent", yieldMs: 0 });
  assert.equal(rejected.outcome, "error");
  const poll = result(await f.use("write_stdin", { sessionId, yieldMs: 1000 }));
  assert.doesNotMatch(String(poll.value.output), /UNEXPECTED-INPUT/);
});

for (const args of [{ chars: 123 }, { eof: "true" }] satisfies JsonObject[]) {
  test(`a mistyped ${Object.keys(args)[0]} is a precise error before touching the real process`, async t => {
    const f = fixture(t);
    const sessionId = await f.background("process.stdin.on('data', () => console.log('UNEXPECTED-INPUT'));");
    const rejected = await f.use("write_stdin", { sessionId, yieldMs: 1000, ...args });
    assert.equal(rejected.outcome, "error", JSON.stringify(rejected));
    if (rejected.outcome === "error") assert.match(rejected.message, new RegExp(Object.keys(args)[0] ?? ""));
    const poll = result(await f.use("write_stdin", { sessionId, yieldMs: 1000 }));
    assert.equal(poll.value.status, "running");
    assert.doesNotMatch(String(poll.value.output), /UNEXPECTED-INPUT/);
  });
}

test("a mistyped runningOnly does not silently return a differently filtered list", async t => {
  const f = fixture(t);
  const rejected = await f.use("list_processes", { runningOnly: "true" });
  assert.equal(rejected.outcome, "error");
  if (rejected.outcome === "error") assert.match(rejected.message, /runningOnly.*boolean/);
});

test("writing after a failed process ended reports its actual exit code in the recovery error", async t => {
  const f = fixture(t);
  const sessionId = await f.background("process.exitCode = 7;");
  await finished(f.use, sessionId);
  const rejected = await f.use("write_stdin", { sessionId, chars: "retry\n", yieldMs: 250 });
  assert.equal(rejected.outcome, "error");
  if (rejected.outcome === "error") {
    assert.equal(rejected.code, "session_finished");
    assert.match(rejected.message, /exit code:? 7/i);
  }
});

test("user can reassemble Chinese and emoji logs across capped background polls", async t => {
  const f = fixture(t, { maxReadBytes: 15 });
  const expected = "中文🙂测试".repeat(20);
  const sessionId = await f.background(`process.stdout.write(${JSON.stringify(expected)});`);
  let output = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    const read = result(await f.use("write_stdin", { sessionId, yieldMs: 1000 }));
    output += String(read.value.output);
    if (read.value.status !== "running" && read.value.bufferedBytes === 0) break;
  }
  assert.equal(output, expected);
});

test("a UTF-8 character split across real stdout packets survives interleaved stderr and polling", async t => {
  const f = fixture(t);
  const sessionId = await f.background("const bytes = Buffer.from('中文🙂'); process.stdout.write(bytes.subarray(0, 1)); process.stderr.write('BETWEEN\\n'); process.stdin.once('data', () => { process.stdout.write(bytes.subarray(1)); process.stdin.destroy(); });");
  let output = "";
  for (let attempt = 0; attempt < 20 && !output.includes("BETWEEN"); attempt++) {
    output += String(result(await f.use("write_stdin", { sessionId, yieldMs: 1000 })).value.output);
  }
  assert.match(output, /BETWEEN/);
  assert.doesNotMatch(output, /�/, "an incomplete live packet must wait for its continuation");
  output += String(result(await f.use("write_stdin", { sessionId, chars: "continue\n", yieldMs: 250 })).value.output);
  output += (await finished(f.use, sessionId)).output;
  assert.match(output, /中文🙂/);
  assert.doesNotMatch(output, /�/);
});

test("evicting old background bytes does not expose a fragment as a fake character", () => {
  const buffer = createBoundedBuffer(5);
  buffer.write(Buffer.from("甲🙂乙"));
  const read = buffer.read(1024);
  assert.equal(read.dropped, true);
  assert.equal(read.text, "乙");
});
