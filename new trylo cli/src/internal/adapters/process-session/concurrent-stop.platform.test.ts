import assert from "node:assert/strict";
import { test } from "node:test";
import { createProcessSessionRegistry } from "./session-registry.js";
import { terminateProcessTree } from "./process-tree.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
for (const operation of ["stop", "shutdown"] as const) {
  test(`a concurrent ${operation} shares the already running native stop`, { timeout: 10000 }, async t => {
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const terminating = new Promise<void>(resolve => { entered = resolve; });
    let attempts = 0;
    const registry = createProcessSessionRegistry({ terminate: async child => {
      attempts += 1;
      entered();
      await released;
      return terminateProcessTree(child);
    } });
    t.after(async () => { release(); await registry.shutdown(); });
    const session = await registry.start({ id: "", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(), env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 1024 });
    const first = registry.stop(session.id);
    await terminating;
    const second = operation === "stop" ? registry.stop(session.id) : registry.shutdown();
    await flush();
    assert.equal(attempts, 1, "concurrent lifecycle owners must not send two native tree kills");
    release();
    const result = await first;
    await second;
    assert.equal(result.ok && result.end.kind, "exited");
    assert.equal(registry.get(session.id)?.status, "exited");
  });
}

test("a shared failed native stop is retryable without admitting duplicate kills", { timeout: 10000 }, async t => {
  let release!: () => void;
  let entered!: () => void;
  let refused = true;
  let attempts = 0;
  const released = new Promise<void>(resolve => { release = resolve; });
  const terminating = new Promise<void>(resolve => { entered = resolve; });
  const registry = createProcessSessionRegistry({ terminate: async child => {
    attempts += 1;
    entered();
    await released;
    return refused ? { ok: false, code: "tree_kill_rejected", message: "injected native refusal" } : terminateProcessTree(child);
  } });
  t.after(async () => { refused = false; release(); await registry.shutdown(); });
  const session = await registry.start({ id: "", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(), env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 1024 });
  const first = registry.stop(session.id);
  await terminating;
  const second = registry.stop(session.id);
  await flush();
  assert.equal(attempts, 1);
  release();
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal(registry.get(session.id)?.status, "running");
  refused = false;
  const retried = await registry.stop(session.id);
  assert.equal(retried.ok && retried.end.kind, "exited");
  assert.equal(attempts, 2);
});
