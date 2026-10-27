import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createPtySessionRegistry } from "./pty-session.js";
import { resolvePtyHelper } from "./pty-loader.js";
import { PTY_OP } from "./pty-protocol.js";

test("concurrent terminal stops send one kill frame and share the confirmed exit", { timeout: 10000 }, async t => {
  const helper = resolvePtyHelper({ override: process.env.TRYLO_PTY_HELPER });
  if (!helper.ok) { t.skip(helper.message); return; }
  let kills = 0;
  const registry = createPtySessionRegistry({ helper, spawnHelper: helperPath => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const input = new PassThrough();
    input.on("data", (chunk: Buffer) => { if (chunk[0] === PTY_OP.kill) kills += 1; });
    input.pipe(child.stdin);
    child.stdin = input;
    return child;
  } });
  t.after(() => { registry.shutdown(); });
  const started = await registry.start({ id: "", argv: [process.execPath, "-e", "console.log('PTY_STOP_READY');setInterval(()=>{},1000)"],
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    tty: true, rows: 24, cols: 80, maxBufferBytes: 65536 });
  let output = "";
  for (let poll = 0; poll < 10 && !output.includes("PTY_STOP_READY"); poll += 1) {
    const ready = await registry.write({ sessionId: started.id, input: "", eof: false, yieldMs: 500 });
    assert.ok(ready.ok);
    if (ready.ok) output += ready.read.output;
  }
  assert.match(output, /PTY_STOP_READY/);
  const results = await Promise.all([registry.stop(started.id), registry.stop(started.id)]);
  assert.ok(results.every(result => result.ok && result.end.kind === "exited"), JSON.stringify({ kills, results }));
  assert.equal(kills, 1, "separate cancellation paths cannot duplicate a native terminal kill");
});
