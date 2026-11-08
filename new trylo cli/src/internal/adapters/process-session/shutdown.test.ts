import assert from "node:assert/strict";
import { test } from "node:test";
import { terminateProcessTree } from "./process-tree.js";
import { createProcessSessionRegistry } from "./session-registry.js";

test("shutdown attempts every live tree and reports a rejected termination", async () => {
  let attempts = 0;
  const children: Parameters<typeof terminateProcessTree>[0][] = [];
  const registry = createProcessSessionRegistry({ terminate: async child => {
    children.push(child);
    attempts++;
    return { ok: false, code: "tree_kill_rejected", message: "injected OS refusal" };
  } });

  try {
    for (let i = 0; i < 2; i++) await registry.start({ id: `ps_${String(i).padStart(24, "0")}`, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 1024 });
    await assert.rejects(registry.shutdown(), /session_cleanup_failed/);
    assert.equal(attempts, 2);
    assert.equal(registry.list().sessions.filter(session => session.status === "running").length, 2);
  } finally {
    // The injected refusal did not kill anything; the test owns real cleanup.
    await Promise.all(children.map(child => terminateProcessTree(child)));
  }
});
