// @test-layer platform
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRunExecution } from "./run-execution-wiring.js";

test("strict Windows background pipes keep stdin open and preserve independently split UTF-8", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-stdin-native-"));
  const script = join(root, "interactive.mjs"), ready = join(root, "ready.json"), result = join(root, "result.json");
  writeFileSync(script, `import {writeSync,writeFileSync} from 'node:fs';import {userInfo} from 'node:os';
const out=Buffer.from('🙂中文\\n'),err=Buffer.from('中文🙂\\n');
writeSync(1,out.subarray(0,2));writeSync(2,err.subarray(0,1));
writeFileSync('ready.json',JSON.stringify({pid:process.pid}));
process.stdin.once('data',data=>{writeSync(1,out.subarray(2));writeSync(2,err.subarray(1));writeFileSync('result.json',JSON.stringify({input:data.toString('utf8'),user:userInfo().username,bridgeEnv:Object.keys(process.env).filter(k=>k.startsWith('TRYLO_STDIN_BRIDGE_'))}));process.exit(0)});
process.stdin.once('end',()=>process.exit(3));process.stdin.resume();
`, "utf8");
  const execution = createRunExecution(root, { env: { ...process.env, TRYLO_HOME: join(root, "home") } });
  try {
    const started = await execution.sessions.start({ id: "stdin-native-probe", argv: [process.execPath, script], cwd: root, env: {},
      tty: false, rows: 24, cols: 80, maxBufferBytes: 65536 });
    // Readiness is an observed child fact, never a wall-clock success assertion.
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await delay(10);
    if (!existsSync(ready)) {
      const diagnostic = await execution.sessions.write({ sessionId: started.id, input: "", eof: false, yieldMs: 10 });
      assert.fail(`the real isolated child must start: ${JSON.stringify(diagnostic)}`);
    }
    const before = await execution.sessions.write({ sessionId: started.id, input: "", eof: false, yieldMs: 100 });
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.read.status, "running", "the isolation broker must not replace application stdin with EOF");
    assert.equal(before.read.output.includes("�"), false, "incomplete UTF-8 remains buffered while the process is running");
    let output = before.read.output;
    const released = await execution.sessions.write({ sessionId: started.id, input: "release\n", eof: false, yieldMs: 500 });
    assert.equal(released.ok, true);
    if (!released.ok) return;
    output += released.read.output;
    let snapshot = execution.sessions.get(started.id);
    while (snapshot?.status === "running" && Date.now() < deadline) {
      const next = await execution.sessions.write({ sessionId: started.id, input: "", eof: false, yieldMs: 250 });
      assert.equal(next.ok, true);
      if (next.ok) output += next.read.output;
      snapshot = execution.sessions.get(started.id);
    }
    assert.equal(snapshot?.status, "exited");
    assert.equal(snapshot?.exitCode, 0);
    assert.ok(output.includes("🙂中文\n")); assert.ok(output.includes("中文🙂\n"));
    assert.equal(output.includes("�"), false);
    const observed = JSON.parse(readFileSync(result, "utf8")) as { input: string; user: string; bridgeEnv: string[] };
    assert.equal(observed.input, "release\n");
    assert.notEqual(observed.user, userInfo().username, "the target must remain under the restricted sandbox account");
    assert.deepEqual(observed.bridgeEnv, [], "transport capabilities must not reach the target environment");

    // Explicit EOF and a nonzero target exit must survive both trusted entries.
    writeFileSync(script, `import {writeFileSync} from 'node:fs';writeFileSync('ready-eof.json','ready');process.stdin.once('end',()=>{process.stdout.write('eof:🙂\\n',()=>process.exit(7))});process.stdin.resume();`);
    const eof = await execution.sessions.start({ id: "stdin-eof-probe", argv: [process.execPath, script], cwd: root, env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 65536 });
    const eofDeadline = Date.now() + 10_000;
    while (!existsSync(join(root, "ready-eof.json")) && Date.now() < eofDeadline) await delay(10);
    assert.ok(existsSync(join(root, "ready-eof.json")));
    const eofRead = await execution.sessions.write({ sessionId: eof.id, input: "", eof: true, yieldMs: 1000 });
    assert.equal(eofRead.ok, true);
    let eofOutput = eofRead.ok ? eofRead.read.output : "";
    while (execution.sessions.get(eof.id)?.status === "running" && Date.now() < eofDeadline) {
      const next = await execution.sessions.write({ sessionId: eof.id, input: "", eof: false, yieldMs: 250 });
      if (next.ok) eofOutput += next.read.output;
    }
    assert.equal(execution.sessions.get(eof.id)?.exitCode, 7);
    assert.equal(eofOutput, "eof:🙂\n");

    // Stopping the registry owner must drain the proxy, broker and isolated target.
    writeFileSync(script, `import {writeFileSync} from 'node:fs';writeFileSync('ready-stop.json',JSON.stringify({pid:process.pid}));process.stdin.resume();setInterval(()=>{},1000);`);
    const stop = await execution.sessions.start({ id: "stdin-stop-probe", argv: [process.execPath, script], cwd: root, env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 65536 });
    const stopDeadline = Date.now() + 10_000;
    while (!existsSync(join(root, "ready-stop.json")) && Date.now() < stopDeadline) await delay(10);
    assert.ok(existsSync(join(root, "ready-stop.json")));
    const stoppedPid = (JSON.parse(readFileSync(join(root, "ready-stop.json"), "utf8")) as { pid: number }).pid;
    const stopped = await execution.sessions.stop(stop.id);
    assert.equal(stopped.ok, true);
    // Unlike signal0 against another logon, tasklist observes the actual PID without requiring a process handle.
    const { execFileSync } = await import("node:child_process");
    const listing = execFileSync(join(process.env["SystemRoot"] ?? "C:/Windows", "System32/tasklist.exe"), ["/FI", `PID eq ${stoppedPid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    assert.equal(listing.includes(`"${stoppedPid}"`), false, "the actual isolated target must be gone after stop");
  } finally {
    await execution.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("trylo-stdin-native-"));
    rmSync(root, { recursive: true, force: true });
  }
});
