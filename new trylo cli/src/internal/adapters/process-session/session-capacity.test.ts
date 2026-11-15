import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createProcessSessionRegistry } from "./session-registry.js";

for (const maximum of [undefined, 1]) {
  test(`process sessions honor ${maximum === undefined ? "omitted capacity without a hidden cap" : "an explicit capacity"}`, async () => {
    const children: ChildProcess[] = [];
    const registry = createProcessSessionRegistry({
      ...(maximum === undefined ? {} : { maxSessions: maximum }),
      spawnProcess: () => {
        const child = new ChildProcess();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        children.push(child);
        return child;
      },
    });
    const start = () => registry.start({ id: "", argv: ["fixture"], cwd: "/fixture", env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 128 });
    try {
      for (let index = 0; index < (maximum === undefined ? 65 : 1); index += 1) await start();
      if (maximum !== undefined) await assert.rejects(start(), /session limit reached/);
      assert.equal(registry.list().sessions.length, maximum === undefined ? 65 : 1);
    } finally {
      for (const child of children) child.emit("exit", 0, null);
      await registry.shutdown();
    }
  });
}
