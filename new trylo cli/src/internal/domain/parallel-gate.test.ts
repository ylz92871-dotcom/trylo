import assert from "node:assert/strict";
import { test } from "node:test";
import { createParallelGate } from "./parallel-gate.js";

/**
 * The gate's contract, stated as behaviour rather than as a description of the
 * code (WP22.1 / C05).
 *
 * Each test here fails on a *simpler* lock, which is the point:
 *
 *  - a plain mutex fails "readers share the lock";
 *  - a read-friendly lock (one that lets a new reader in whenever reads are
 *    already running) fails "a waiting writer is not overtaken";
 *  - a bare counter fails "a writer waits for every reader".
 */

/** Lets queued promise callbacks run before the next assertion. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("two readers hold the shared lock at once", async () => {
  const gate = createParallelGate();
  const first = await gate.read();
  let secondAdmitted = false;
  const pending = gate.read().then((release) => {
    secondAdmitted = true;
    return release;
  });

  await tick();
  // A mutex would leave the second reader waiting on the first release.
  assert.equal(secondAdmitted, true, "a shared lock must admit a second reader");

  first();
  await pending;
});

test("a writer waits for every reader, not just the first", async () => {
  const gate = createParallelGate();
  const first = await gate.read();
  const second = await gate.read();
  let writeAdmitted = false;
  const pending = gate.write().then((release) => {
    writeAdmitted = true;
    return release;
  });

  await tick();
  assert.equal(writeAdmitted, false, "a writer must not enter while readers hold the lock");

  first();
  await tick();
  assert.equal(
    writeAdmitted,
    false,
    "releasing one of two readers must not admit the writer",
  );

  second();
  await tick();
  assert.equal(writeAdmitted, true);
  await pending;
});

test("a reader does not enter while a writer holds the lock", async () => {
  const gate = createParallelGate();
  const writing = await gate.write();
  let readAdmitted = false;
  const pending = gate.read().then((release) => {
    readAdmitted = true;
    return release;
  });

  await tick();
  assert.equal(readAdmitted, false, "an exclusive lock must exclude readers");

  writing();
  await tick();
  assert.equal(readAdmitted, true);
  await pending;
});

test("a waiting writer is not overtaken by a reader that arrived later", async () => {
  const gate = createParallelGate();
  const reader = await gate.read();
  const order: string[] = [];

  // The writer queues first; the reader behind it must not jump the queue.
  const writing = gate.write().then((release) => {
    order.push("write");
    release();
    return release;
  });
  const queuedReader = gate.read().then((release) => {
    order.push("read");
    release();
    return release;
  });

  await tick();
  reader();
  await tick();
  await tick();

  // A reader-friendly lock would produce ["read", "write"] here.
  assert.deepEqual(order, ["write", "read"], "waiters are served in arrival order");

  await writing;
  await queuedReader;
});

test("releasing twice releases once", async () => {
  const gate = createParallelGate();
  const writing = await gate.write();
  let admitted = 0;
  const first = gate.read().then((release) => {
    admitted += 1;
    release();
    return release;
  });
  const second = gate.read().then((release) => {
    admitted += 1;
    release();
    return release;
  });

  await tick();
  assert.equal(admitted, 0);
  writing();
  writing(); // The second call must not hand the lock to anyone extra.
  await tick();
  assert.equal(admitted, 2);

  // The lock is still usable and still exclusive afterwards.
  await first;
  await second;
  const nextWriter = await gate.write();

  nextWriter();
});
