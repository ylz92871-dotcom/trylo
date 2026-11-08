import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createQueueClaim, discoverQueuedSessions, type QueueDirIo } from "./claim.js";
import { createFileBackgroundQueue } from "../queue-store/file-queue.js";

/**
 * 领取的测试，打在真文件系统上。
 *
 * 假文件系统只能证明算术；这条端口存在的理由（「一条消息只被一个执行者拿走」）
 * 只有在两个进程真去抢同一个文件时才看得见。
 */

function tempHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), "wp26-worker-"));
  const queueDir = path.join(root, "queue");
  mkdirSync(queueDir, { recursive: true });
  return root;
}

function fifoClock(): { now: () => number; newId: (prefix: string) => string } {
  let tick = 0;
  return {
    now: () => 1_000 + tick * 100,
    newId: (prefix: string) => {
      tick += 1;
      return `${prefix}_${tick}`;
    },
  };
}

test("领走的是队首，且领完队列里就少了它", async () => {
  const home = tempHome();
  const clock = fifoClock();
  const queuePathFor = (sessionId: string): string => path.join(home, "queue", `${sessionId}.ndjson`);
  const queue = createFileBackgroundQueue({ path: queuePathFor("s1"), clock });
  const first = await queue.enqueue("first");

  await queue.enqueue("second");
  assert.equal(first.ok, true);

  const claim = createQueueClaim({ queuePathFor, clock });
  const got = await claim.claim("s1");

  assert.equal(got.ok, true);

  if (got.ok) {
    assert.equal(got.value.text, "first");
    assert.equal(got.value.messageId, first.ok ? first.value.id : "");
  }

  const after = await queue.list(0, 10);

  assert.equal(after.ok, true);

  if (after.ok) {
    assert.equal(after.value.total, 1);
    assert.equal(after.value.items[0]?.text, "second");
  }
});

test("队列空时是 no_work，不是失败", async () => {
  const home = tempHome();
  const clock = fifoClock();
  const queuePathFor = (sessionId: string): string => path.join(home, "queue", `${sessionId}.ndjson`);
  const claim = createQueueClaim({ queuePathFor, clock });
  const got = await claim.claim("empty_session");

  assert.equal(got.ok, false);

  if (!got.ok) {
    assert.equal(got.code, "no_work");
  }
});

test("两个工作者抢同一条，恰好一个领到", async () => {
  const home = tempHome();
  const clock = fifoClock();
  const queuePathFor = (sessionId: string): string => path.join(home, "queue", `${sessionId}.ndjson`);
  const queue = createFileBackgroundQueue({ path: queuePathFor("s1"), clock });

  await queue.enqueue("only-once");

  const claimA = createQueueClaim({ queuePathFor, clock });
  const claimB = createQueueClaim({ queuePathFor, clock });
  const [ra, rb] = await Promise.all([claimA.claim("s1"), claimB.claim("s1")]);
  const winners = [ra, rb].filter((r) => r.ok);

  // 有牙：若 delete 对「已被别人领走」返回成功，这里会变成 2 —— 同一条话被跑两遍。
  assert.equal(winners.length, 1);
  const loser = ra.ok ? rb : ra;

  assert.equal(loser.ok, false);

  if (!loser.ok) {
    // 输家报什么码取决于时序：可能撞上对方正持有的写锁（queue_locked），也可能
    // 对方已经把那条删掉了（unknown_item）。两者都是「没领到」——要紧的是它
    // 绝不能也去跑那一条。
    assert.ok(
      loser.code === "queue_locked" || loser.code === "unknown_item",
      `the loser must say why it got nothing, got ${loser.code}`
    );
  }
});

test("一个会话的队列不会被另一个会话的活顶掉", async () => {
  const home = tempHome();
  const clock = fifoClock();
  const queuePathFor = (sessionId: string): string => path.join(home, "queue", `${sessionId}.ndjson`);
  const q1 = createFileBackgroundQueue({ path: queuePathFor("s1"), clock });
  const q2 = createFileBackgroundQueue({ path: queuePathFor("s2"), clock });

  await q1.enqueue("for-s1");
  await q2.enqueue("for-s2");

  const claim = createQueueClaim({ queuePathFor, clock });
  const got = await claim.claim("s2");

  assert.equal(got.ok, true);

  if (got.ok) {
    assert.equal(got.value.text, "for-s2");
    assert.equal(got.value.sessionId, "s2");
  }
});

test("队列目录为空时，发现不出任何会话", () => {
  const io: QueueDirIo = { readDir: () => [], statFile: () => 1 };
  assert.deepEqual(discoverQueuedSessions(io, "/whatever"), []);
});

test("发现会跳过非队列文件与危险名字", () => {
  const io: QueueDirIo = {
    readDir: () => ["a.ndjson", "notes.txt", "..", "..escape.ndjson", "b.ndjson"],
    statFile: (p: string) => (p.includes("..escape") ? 2 : 3),
  };
  // "..escape.ndjson" 含 ".." 会被拒 —— 这样的名字可能指到队列目录外面去，拿它
  // 当会话 id 去消费，就是在敲一个不存在的会话。notes.txt 不是队列文件，
  // ".." 根本不是文件。
  const found = discoverQueuedSessions(io, "/d");

  assert.deepEqual(found, ["a", "b"]);
});

test("队列目录读不到时不抛，返回空", () => {
  const io: QueueDirIo = {
    readDir: () => {
      throw new Error("gone");
    },
    statFile: () => 1,
  };
  assert.deepEqual(discoverQueuedSessions(io, "/d"), []);
});
