import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileBackgroundQueue } from "./file-queue.js";
import { lockHeldByThisProcess } from "./queue-writer.js";
import { MAX_QUEUED_MESSAGES } from "../../ports/background-queue.js";

/**
 * The queue against a real filesystem, and against a real second process.
 *
 * A fake would prove the arithmetic and nothing else. Three of the properties
 * this port exists for are only visible on disk: that an append survives the
 * process that wrote it, that a torn line is refused instead of skipped, and
 * that a second *process* is turned away rather than allowed to write at the
 * same time. The last one cannot be shown in-process at all — two callers in one
 * process share a lock object, and a lock object proves nothing about a file.
 */

function tempQueue(): { readonly dir: string; readonly file: string; readonly clock: { now: () => number; newId: (prefix: string) => string } } {
  const dir = mkdtempSync(path.join(tmpdir(), "wp08-queue-"));
  const file = path.join(dir, "queue.ndjson");
  let counter = 0;

  return {
    dir,
    file,
    clock: {
      now: () => 1_700_000_000_000 + counter,
      // Deterministic ids: a test that cannot say which message is which cannot
      // prove that a reorder touched the right ones.
      newId: (prefix: string) => `${prefix}${counter++}`,
    },
  };
}

async function mustOk<T>(promise: Promise<{ ok: true; value: T } | { ok: false; code: string }>): Promise<T> {
  const outcome = await promise;
  assert.equal(outcome.ok, true, `expected success, got ${outcome.ok ? "" : outcome.code}`);
  if (!outcome.ok) {
    throw new Error("unreachable after the assertion above");
  }
  return outcome.value;
}

test("a queued message is still there after the queue object is gone and a new one reads it", async () => {
  const { file, clock } = tempQueue();
  const first = createFileBackgroundQueue({ path: file, clock });
  const queued = await mustOk(first.enqueue("do the thing"));

  await first.release();

  // A brand new object, as a second `trylo queue` process would build.
  const second = createFileBackgroundQueue({ path: file, clock });
  const listed = await mustOk(second.list(0, 10));

  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items, [queued]);
  await second.release();
});

test("messages come back in the order they were queued, not the order they were read", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });
  const a = await mustOk(queue.enqueue("first"));
  const b = await mustOk(queue.enqueue("second"));
  const c = await mustOk(queue.enqueue("third"));

  const listed = await mustOk(queue.list(0, 10));

  assert.deepEqual(listed.items.map((item) => item.text), ["first", "second", "third"]);
  assert.deepEqual(listed.items.map((item) => item.id), [a.id, b.id, c.id]);
  await queue.release();
});

test("paging reports how many there are, so a short page is never read as all of it", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });

  for (let index = 0; index < 5; index += 1) {
    await mustOk(queue.enqueue(`m${index}`));
  }

  const page = await mustOk(queue.list(2, 2));

  assert.equal(page.total, 5);
  assert.deepEqual(page.items.map((item) => item.text), ["m2", "m3"]);
  await queue.release();
});

test("the hundred-and-first message is refused, and the hundredth is not", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });
  // Seeded directly so the test does not spend a hundred fsyncs proving the
  // arithmetic the domain test already covers.
  const seeded = Array.from(
    { length: MAX_QUEUED_MESSAGES },
    (_, index) => `${JSON.stringify({ id: `seed${index}`, text: `m${index}`, enqueuedAtMs: 1 })}\n`,
  ).join("");

  writeFileSync(file, seeded);

  const refused = await queue.enqueue("one too many");

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "full");
  }

  const listed = await mustOk(queue.list(0, 1));

  assert.equal(listed.total, MAX_QUEUED_MESSAGES);
  await queue.release();
});

test("a torn line fails the whole read, because skipping it would hide a message", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });

  await mustOk(queue.enqueue("intact"));
  // A half-written last line: exactly what a crash mid-append leaves.
  writeFileSync(file, `${readFileSync(file, "utf8")}{"id":"x","text":"half`);
  const listed = await queue.list(0, 10);

  assert.equal(listed.ok, false);

  if (!listed.ok) {
    assert.equal(listed.code, "queue_unreadable");
  }

  // And nothing is appended onto the corruption.
  const refused = await queue.enqueue("after the tear");

  assert.equal(refused.ok, false);
  await queue.release();
});

test("a second process is turned away instead of writing at the same time", async () => {
  const { dir, file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });

  // Hold the lock the way a slow writer looks like from the outside: the file
  // exists and names another process. This is deliberately *not* a lock object
  // this test owns — the property under test is about the file, and an
  // in-process lock object would prove nothing about a second process.
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.lock`, "999999\n");

  const refused = await queue.enqueue("while another writer holds it");

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "queue_locked");
  }

  assert.equal(existsSync(file), false, "a refused message must not have been written");

  // And a real separate process, not just a simulated one: `wx` on an existing
  // lock is what refuses it, and this proves it across a process boundary.
  // argv[2], not argv[1]: with `node script.cjs <arg>` the script itself is
  // argv[1], and reading the queue path from the wrong slot makes the child
  // contend for a lock file that does not exist — which "acquires" and looks
  // exactly like a broken lock.
  const childPath = path.join(dir, "contend.cjs");

  writeFileSync(
    childPath,
    `const fs = require("node:fs");
     const file = process.argv[2];
     try {
       const fd = fs.openSync(file + ".lock", "wx");
       fs.writeFileSync(fd, String(process.pid) + "\\n");
       fs.closeSync(fd);
       console.log("acquired");
     } catch (e) { console.log(e.code === "EEXIST" ? "refused" : String(e.code)); }
    `,
  );
  const child = spawnSync(process.execPath, [childPath, file], { encoding: "utf8" });

  assert.equal(child.stdout.trim(), "refused", "another process must not be able to take the lock");
  // The refused child left the lock exactly as it found it.
  assert.equal(readFileSync(`${file}.lock`, "utf8").trim(), "999999");

  await queue.release();
  // Our release gave back a lock we never took, so the other writer's lock is
  // still there — releasing what you do not hold must not unlock the holder.
  assert.equal(readFileSync(`${file}.lock`, "utf8").trim(), "999999", "another writer's lock must survive our release");
});

test("the lock is given back after a refusal, so one full queue is not a stuck one", async () => {
  const { file, clock } = tempQueue();

  writeFileSync(
    file,
    Array.from(
      { length: MAX_QUEUED_MESSAGES },
      (_, index) => `${JSON.stringify({ id: `seed${index}`, text: `m${index}`, enqueuedAtMs: 1 })}\n`,
    ).join(""),
  );
  const queue = createFileBackgroundQueue({ path: file, clock });
  const refused = await queue.enqueue("too many");

  assert.equal(refused.ok, false);
  // The refusal ended the operation, and the operation owned the lock.
  assert.throws(() => readFileSync(`${file}.lock`, "utf8"), /ENOENT/, "the lock must be released");
  await queue.release();
});

test("update keeps a message's place and delete removes exactly one", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });
  const a = await mustOk(queue.enqueue("first"));
  const b = await mustOk(queue.enqueue("second"));
  const c = await mustOk(queue.enqueue("third"));

  const updated = await mustOk(queue.update(b.id, "second, revised"));

  assert.equal(updated.text, "second, revised");
  assert.equal(updated.id, b.id);
  let listed = await mustOk(queue.list(0, 10));

  assert.deepEqual(listed.items.map((item) => item.id), [a.id, b.id, c.id], "update must not reorder");

  await mustOk(queue.delete(b.id));
  listed = await mustOk(queue.list(0, 10));
  assert.deepEqual(listed.items.map((item) => item.id), [a.id, c.id]);

  const gone = await queue.delete("no-such-id");

  assert.equal(gone.ok, false);

  if (!gone.ok) {
    assert.equal(gone.code, "unknown_item");
  }

  await queue.release();
});

test("reorder moves every message and refuses anything that is not the whole queue", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });
  const a = await mustOk(queue.enqueue("first"));
  const b = await mustOk(queue.enqueue("second"));
  const c = await mustOk(queue.enqueue("third"));

  await mustOk(queue.reorder([c.id, a.id, b.id]));
  const listed = await mustOk(queue.list(0, 10));

  assert.deepEqual(listed.items.map((item) => item.id), [c.id, a.id, b.id]);

  // A prefix is refused rather than applied: applying it would delete messages.
  const refused = await queue.reorder([c.id]);

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "order_not_a_permutation");
  }

  const unchanged = await mustOk(queue.list(0, 10));

  assert.equal(unchanged.total, 3, "a refused reorder must leave every message in place");
  await queue.release();
});

test("a blank message is refused and no file is created for it", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });
  const refused = await queue.enqueue("   ");

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "blank");
  }

  // Nothing was written — not even an empty file. A refusal that created the
  // file would have made the next read say "an empty queue" instead of "nothing
  // was ever queued here".
  assert.equal(existsSync(file), false);
  await queue.release();
});

test("the file is one JSON object per line, so it can be read without this code", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });

  await mustOk(queue.enqueue("first"));
  await mustOk(queue.enqueue("second"));
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);

  assert.equal(lines.length, 2);

  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(typeof parsed["id"], "string");
    assert.equal(typeof parsed["text"], "string");
  }

  await queue.release();
});

test("a queue file left by another writer is never silently replaced", async () => {
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });

  await mustOk(queue.enqueue("mine"));
  // Something that is not a queued message at all.
  writeFileSync(file, "not json at all\n");
  const refused = await queue.enqueue("after the garbage");

  assert.equal(refused.ok, false);
  assert.equal(readFileSync(file, "utf8"), "not json at all\n", "the file is left exactly as found");
  await queue.release();
});

test("lockHeldByThisProcess reads a lock file for diagnostics without deciding anything", () => {
  const { file } = tempQueue();
  const lockPath = `${file}.lock`;
  const handle = openSync(lockPath, "wx");

  try {
    writeFileSync(lockPath, `${process.pid}\n`);
  } finally {
    closeSync(handle);
  }

  assert.equal(lockHeldByThisProcess(lockPath), true);
  // A lock naming another process is reported as not ours — read for a human to
  // look at, never used to decide whether the lock may be taken.
  writeFileSync(lockPath, "999999\n");
  assert.equal(lockHeldByThisProcess(lockPath), false);
});

test("requeue keeps the original id and arrival time, and is idempotent per id", async () => {
  // The worker's durable handoff record is keyed by the message id. A restore that
  // minted a new id would leave that record pointing at nothing, and "never re-run
  // a job whose outcome is unknown" would silently stop holding while every test
  // about queue *length* stayed green — which is exactly what this verb prevents.
  const { file, clock } = tempQueue();
  const queue = createFileBackgroundQueue({ path: file, clock });
  const queued = await queue.enqueue("ambiguous");

  assert.equal(queued.ok, true);

  if (!queued.ok) return;

  assert.equal((await queue.delete(queued.value.id)).ok, true);

  const back = await queue.requeue(queued.value);

  assert.equal(back.ok, true);

  if (!back.ok) return;

  assert.equal(back.value.id, queued.value.id, "the id must survive the round trip");
  assert.equal(back.value.enqueuedAtMs, queued.value.enqueuedAtMs, "and so must its arrival time");

  const again = await queue.requeue(queued.value);

  assert.equal(again.ok, true);
  const page = await queue.list(0, 10);

  assert.equal(page.ok, true);

  if (page.ok) {
    assert.equal(page.value.total, 1, "re-presenting an id already queued must not duplicate it");
  }
});
