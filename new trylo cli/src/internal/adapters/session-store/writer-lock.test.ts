import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireLock, createJournalIo, releaseLock, stillHoldingLock } from "./journal-io.js";
import type { ProcessStatus } from "./writer-lock.js";

function fixture(t: import("node:test").TestContext, status: ProcessStatus) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trylo-writer-lock-")), file = path.join(root, "session.ndjson");
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const io = createJournalIo({ path: file, ownerPid: 200, ownerToken: "owner-a", processStatus: () => status });
  return { io, second: () => createJournalIo({ path: file, ownerPid: 200, ownerToken: "owner-b", processStatus: () => "alive" }),
    lock: file + ".lock" };
}

test("a provably dead legacy PID lock is reclaimed before resuming", t => {
  const f = fixture(t, "dead");
  fs.writeFileSync(f.lock, "123\n");
  assert.equal(acquireLock(f.io).ok, true);
  assert.equal(stillHoldingLock(f.io), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.lock, "utf8")), { pid: 200, token: "owner-a" });
  assert.equal(acquireLock(f.second()).ok, false);
  releaseLock(f.io);
  assert.equal(fs.existsSync(f.lock), false);
});

for (const status of ["alive", "unknown"] as const) test(`a ${status} lock owner is never reclaimed`, t => {
  const f = fixture(t, status), original = '{"pid":123,"token":"old"}\n';
  fs.writeFileSync(f.lock, original);
  assert.equal(acquireLock(f.io).ok, false);
  assert.equal(fs.readFileSync(f.lock, "utf8"), original);
});

test("malformed, oversized and unknown ownership cannot grant recovery", t => {
  const f = fixture(t, "dead");
  for (const original of ["unknown", "0", "-1", "9".repeat(600), '{"pid":123}']) {
    fs.writeFileSync(f.lock, original);
    assert.equal(acquireLock(f.io).ok, false);
    assert.equal(fs.readFileSync(f.lock, "utf8"), original);
  }
});

test("a contended recovery guard preserves the prior lock", t => {
  const f = fixture(t, "dead");
  fs.writeFileSync(f.lock, "123\n");
  fs.writeFileSync(f.lock + ".reclaim", "other-reclaimer");
  assert.equal(acquireLock(f.io).ok, false);
  assert.equal(fs.readFileSync(f.lock, "utf8"), "123\n");
});

test("a stale instance cannot append under or release another token in the same process", t => {
  const f = fixture(t, "alive");
  assert.equal(acquireLock(f.io).ok, true);
  const replacement = '{"pid":200,"token":"owner-b"}\n';
  fs.writeFileSync(f.lock, replacement);
  assert.equal(stillHoldingLock(f.io), false);
  releaseLock(f.io);
  assert.equal(fs.readFileSync(f.lock, "utf8"), replacement);
});
