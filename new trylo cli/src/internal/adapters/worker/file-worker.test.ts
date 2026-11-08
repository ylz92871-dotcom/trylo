import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileWorker } from "./file-worker.js";
import { createFileHandoffStore } from "./handoff.js";
import { createFileBackgroundQueue } from "../queue-store/file-queue.js";
import { computeOwnerRef } from "../../domain/worker.js";
import type {
  HandoffProbe,
  WorkerExecutionOwner,
  WorkerJob,
  WorkerTurnResult,
} from "../../ports/worker.js";

/**
 * 一趟 pass 与交接窗口的测试。
 *
 * 后面几条专打「交接中崩溃」这一种失败：它不在正常路径上，只有伪造一条
 * `handing_off` 遗留记录才造得出来，而后果恰恰是最坏的那两种 —— 丢任务、
 * 或者同一个任务被跑两遍。
 */

const IDENTITY = { pid: 1, startedAtMs: 0 };

function tempHome(): { readonly home: string; readonly queueDir: string; readonly handoffFile: string } {
  const home = mkdtempSync(path.join(tmpdir(), "wp26-pass-"));
  const queueDir = path.join(home, "queue");
  mkdirSync(queueDir, { recursive: true });
  return { home, queueDir, handoffFile: path.join(home, "worker", "handoff.ndjson") };
}

function queuePathFor(home: string): (sessionId: string) => string {
  return (sessionId: string): string => path.join(home, "queue", `${sessionId}.ndjson`);
}

function clock(): { now: () => number; newId: (prefix: string) => string } {
  let tick = 0;
  return {
    now: () => 1_000 + tick * 10,
    newId: (prefix: string) => {
      tick += 1;
      return `${prefix}_${tick}`;
    },
  };
}

/** An owner that behaves however this test needs it to. */
function ownerOf(options: {
  readonly execute: (job: WorkerJob) => Promise<WorkerTurnResult>;
  readonly probe?: (ref: string) => Promise<HandoffProbe>;
}): WorkerExecutionOwner {
  return {
    execute: options.execute,
    probe: options.probe ?? (async () => "received" as HandoffProbe),
  };
}

test("一趟从队列领一条活，并把它交给执行 owner", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });

  await queue.enqueue("build the board");

  const seen: string[] = [];
  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs: createFileHandoffStore({ file: handoffFile }),
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (job: WorkerJob): Promise<WorkerTurnResult> => {
        seen.push(job.text);
        return { outcome: "completed" };
      },
    }),
  });
  const result = await worker.pass();

  assert.equal(result.taken, 1);
  assert.deepEqual(seen, ["build the board"]);
});

test("交接成功之后，交接记录是 acked，队列里也不再留着它", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });
  const enqueued = await queue.enqueue("done soon");

  assert.equal(enqueued.ok, true);

  const handoffs = createFileHandoffStore({ file: handoffFile });
  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs,
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => ({ outcome: "completed" }),
    }),
  });

  await worker.pass();
  const record = await handoffs.get("s1", enqueued.ok ? enqueued.value.id : "");

  assert.equal(record?.state, "acked");
  const left = await queue.list(0, 20);

  assert.equal(left.ok, true);

  if (left.ok) {
    assert.equal(left.value.total, 0);
  }
});

test("owner 说没收到而队列项已删 —— 任务被补回队列，没有丢", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });

  await queue.enqueue("must survive");

  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs: createFileHandoffStore({ file: handoffFile }),
    worker: IDENTITY,
    owner: ownerOf({
      // 抛异常才是「不知道交没交出去」那一类；正常返回 failed 只说明它跑败了，
      // owner 确实接过手 —— 那种情况不该补回队列。
      execute: async (): Promise<WorkerTurnResult> => {
        throw new Error("handoff did not land");
      },
      probe: async () => "not_received",
    }),
  });

  await worker.pass();
  // 有牙：这一条是「交接中崩溃不能丢任务」的全部内容。补不回去，这条就没了。
  const left = await queue.list(0, 20);

  assert.equal(left.ok, true);

  if (left.ok) {
    assert.equal(left.value.total, 1);
    assert.equal(left.value.items[0]?.text, "must survive");
  }
});

test("owner 说已经收到了 —— 不再补回队列，避免跑两遍", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });

  await queue.enqueue("already taken");

  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs: createFileHandoffStore({ file: handoffFile }),
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => ({ outcome: "failed" }),
      probe: async () => "received",
    }),
  });

  await worker.pass();
  // 有牙：补回去就是同一句话被跑两遍。
  const left = await queue.list(0, 20);

  assert.equal(left.ok, true);

  if (left.ok) {
    assert.equal(left.value.total, 0);
  }
});

test("owner 也查不出来 —— 补回队列让人看见，但下一趟不会自动再跑", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });
  const enqueued = await queue.enqueue("ambiguous");

  assert.equal(enqueued.ok, true);

  const handoffs = createFileHandoffStore({ file: handoffFile });
  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs,
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => {
        throw new Error("ambiguous ending");
      },
      probe: async () => "unknown",
    }),
  });

  await worker.pass();
  const record = await handoffs.get("s1", enqueued.ok ? enqueued.value.id : "");

  assert.equal(record?.state, "unknown");
  // 队列项在领取那一刻就删了；unknown 时若什么都不做，这条就真没了 —— 补回是「不丢任务」。
  const left = await queue.list(0, 20);

  assert.equal(left.ok, true);

  if (left.ok) {
    assert.equal(left.value.total, 1);
  }

  // 有牙：补回不等于重做。再跑一趟，它必须还在那里 —— worker 看到 unknown 记录
  // 应当跳过，而不是自己跑一遍「可能已经跑过」的任务。
  await worker.pass();
  const after = await queue.list(0, 20);

  assert.equal(after.ok, true);

  if (after.ok) {
    assert.equal(after.value.total, 1);
  }
});

test("被扣住的那条留在原地，但它后面的照走 —— 队首不许堵死整个会话", async () => {
  // 这是"unknown 补回队列"的代价被修掉的那条。旧行为是队首一带交接记录就
  // `continue` 掉整个会话：一条无法判定的作业能把后面所有消息无限期堵死。
  // 现在的合同：那条**留在队列里可见**（不重跑、不删），后面的消息继续按序被领。
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });
  const blocked = await queue.enqueue("ambiguous");

  assert.equal(blocked.ok, true);
  const handoffs = createFileHandoffStore({ file: handoffFile });
  const executed: string[] = [];
  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs,
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => {
        throw new Error("ambiguous ending");
      },
      probe: async () => "unknown",
    }),
  });

  await worker.pass();
  const record = await handoffs.get("s1", blocked.ok ? blocked.value.id : "");

  assert.equal(record?.state, "unknown");

  // 换一个看得见结果的执行器：它记录自己跑了什么文本。
  const seeing = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs,
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (job): Promise<WorkerTurnResult> => {
        executed.push(job.text);
        return { outcome: "completed" };
      },
    }),
  });
  const next = await queue.enqueue("behind the blocked one");

  assert.equal(next.ok, true);

  await seeing.pass();
  assert.deepEqual(executed, ["behind the blocked one"], "被扣住的后面那条必须能走");
  const left = await queue.list(0, 20);

  assert.equal(left.ok, true);

  if (left.ok) {
    assert.equal(left.value.total, 1, "扣住的那条不许被删掉或跑掉，它得留在队列里给人看见");
    assert.equal(left.ok && left.value.items[0]?.text, "ambiguous");
  }
});

test("上一任崩在交接窗口里、owner 说没收到 —— 重启后补回队列", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });
  const handoffs = createFileHandoffStore({ file: handoffFile });

  // 伪造上一任的遗留：记录写了、队列项已经没了。
  await handoffs.put({
    sessionId: "s1",
    messageId: "msg_crashed",
    text: "survive the crash",
    state: "handing_off",
    startedAtMs: 1_000,
    worker: { pid: 999, startedAtMs: 900 },
    ownerRef: computeOwnerRef("s1", "msg_crashed"),
  });

  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs,
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => ({ outcome: "completed" }),
      probe: async () => "not_received",
    }),
  });

  await worker.pass();
  const left = await queue.list(0, 20);

  assert.equal(left.ok, true);

  if (left.ok) {
    assert.equal(left.value.total, 1);
    assert.equal(left.value.items[0]?.text, "survive the crash");
  }
});

test("上一任崩在交接窗口里、owner 说收到了 —— 重启后补上确认", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const handoffs = createFileHandoffStore({ file: handoffFile });

  await handoffs.put({
    sessionId: "s1",
    messageId: "msg_acked",
    text: "already running",
    state: "handing_off",
    startedAtMs: 1_000,
    worker: { pid: 999, startedAtMs: 900 },
    ownerRef: computeOwnerRef("s1", "msg_acked"),
  });

  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs,
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => ({ outcome: "completed" }),
      probe: async () => "received",
    }),
  });

  await worker.pass();
  const record = await handoffs.get("s1", "msg_acked");

  assert.equal(record?.state, "acked");
});

test("交接标识由会话与消息派生，不靠 owner 返回", () => {
  // 有牙：ref 若由 owner 返回，崩溃在「owner 收下之后、回话之前」时手里就没有
  // ref 可问 —— 派生的 ref 在交接之前就确定了，重问问到的是同一个东西。
  assert.equal(computeOwnerRef("s1", "m1"), computeOwnerRef("s1", "m1"));
  assert.notEqual(computeOwnerRef("s1", "m1"), computeOwnerRef("s1", "m2"));
  assert.notEqual(computeOwnerRef("s1", "m1"), computeOwnerRef("s2", "m1"));
});

test("队列空时一趟领 0 条并报 no_work", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  let calls = 0;
  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs: createFileHandoffStore({ file: handoffFile }),
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => {
        calls += 1;
        return { outcome: "completed" };
      },
    }),
  });
  const result = await worker.pass();

  assert.equal(result.taken, 0);
  assert.equal(result.refused, "no_work");
  assert.equal(calls, 0);
});

test("一趟的条数封顶在预算内", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });

  for (let i = 0; i < 10; i += 1) {
    await queue.enqueue(`job-${i}`);
  }

  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs: createFileHandoffStore({ file: handoffFile }),
    worker: IDENTITY,
    budget: 3,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => ({ outcome: "completed" }),
    }),
  });
  const result = await worker.pass();

  assert.equal(result.taken, 3);
  const left = await queue.list(0, 20);

  assert.equal(left.ok, true);

  if (left.ok) {
    assert.equal(left.value.total, 7);
  }
});

test("执行器抛异常时记成 failed，不把这一趟打掉", async () => {
  const { home, queueDir, handoffFile } = tempHome();
  const time = clock();
  const queue = createFileBackgroundQueue({ path: queuePathFor(home)("s1"), clock: time });

  await queue.enqueue("boom");

  const worker = createFileWorker({
    queuePathFor: queuePathFor(home),
    queueDir,
    clock: time,
    handoffs: createFileHandoffStore({ file: handoffFile }),
    worker: IDENTITY,
    owner: ownerOf({
      execute: async (): Promise<WorkerTurnResult> => {
        throw new Error("executor exploded");
      },
      probe: async () => "not_received",
    }),
  });
  const result = await worker.pass();

  assert.equal(result.taken, 1);
  const receipts = await worker.receipts();

  assert.equal(receipts[0]?.outcome, "failed");
  assert.match(receipts[0]?.detail ?? "", /executor exploded/);
});
