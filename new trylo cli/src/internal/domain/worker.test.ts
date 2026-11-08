import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_WORKER_BUDGET,
  describeOutcome,
  passOf,
  passShouldStop,
  receiptIsStale,
  receiptOf,
  shouldContinuePass,
} from "./worker.js";
import type { WorkerIdentity, WorkerJob } from "../ports/worker.js";

/**
 * worker 策略的测试。
 *
 * 每一条都针对一个「写错了但纯算术测试照样绿」的地方。
 */

const WORKER: WorkerIdentity = { pid: 4242, startedAtMs: 900 };

function job(overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    sessionId: "sess_1",
    messageId: "msg_1",
    text: "do the thing",
    enqueuedAtMs: 1_000,
    ...overrides,
  };
}

test("只有跑成功的活才接着领下一条", () => {
  assert.equal(shouldContinuePass({ outcome: "completed" }), true);
  // 失败、取消、unknown 都停：一个刚失败的执行器，下一条大概率以同样方式失败，
  // 连着跑会把第一条真正的报错淹进噪声里。
  assert.equal(shouldContinuePass({ outcome: "failed" }), false);
  assert.equal(shouldContinuePass({ outcome: "cancelled" }), false);
  assert.equal(shouldContinuePass({ outcome: "unknown" }), false);
});

test("没有 detail 的回执不写出 detail 键", () => {
  const receipt = receiptOf(job(), { outcome: "completed" }, 1_000, 2_000, WORKER);
  assert.equal(receipt.outcome, "completed");
  // 有牙：实现若总是写 `detail: undefined`，落盘后会多一个空键，
  // 读的人分不清「没写」和「写了空」。
  assert.equal("detail" in receipt, false);
});

test("有 detail 的回执带上它", () => {
  const receipt = receiptOf(job(), { outcome: "failed", detail: "401" }, 1_000, 2_000, WORKER);
  assert.equal(receipt.detail, "401");
});

test("回执保留时间戳与身份", () => {
  const source = job({ sessionId: "sess_9", messageId: "msg_9" });
  const receipt = receiptOf(source, { outcome: "cancelled" }, 5, 9, WORKER);

  assert.equal(receipt.sessionId, "sess_9");
  assert.equal(receipt.messageId, "msg_9");
  assert.equal(receipt.startedAtMs, 5);
  assert.equal(receipt.endedAtMs, 9);
  assert.equal(receipt.endedAtMs - receipt.startedAtMs, 4);
  // 回执要能回答「是我跑的还是上一任留下的」。
  assert.equal(receipt.worker.pid, 4242);
});

test("四种结局各有各的说法，不互相含糊", () => {
  // 有牙：若 describeOutcome 是个兜底 default，四句会一样，
  // 「跑完了」和「不知道落没落」就成了同一件事。
  const said = new Set([
    describeOutcome("completed"),
    describeOutcome("failed"),
    describeOutcome("cancelled"),
    describeOutcome("unknown"),
  ]);

  assert.equal(said.size, 4);
  assert.match(describeOutcome("unknown"), /without knowing/);
});

test("pass 报告条数与停下理由", () => {
  const clean = passOf(2);
  assert.equal(clean.taken, 2);
  assert.equal("refused" in clean, false);
  const stopped = passOf(1, "queue_unreadable");
  assert.equal(stopped.taken, 1);
  assert.equal(stopped.refused, "queue_unreadable");
});

test("队列空不整趟停，读不到才停", () => {
  // 有牙：把 no_work 也当停止，人在「队列本来就是空的」时会被无谓地停掉 daemon。
  assert.equal(passShouldStop("no_work"), false);
  assert.equal(passShouldStop("queue_unreadable"), true);
  assert.equal(passShouldStop("queue_locked"), true);
  assert.equal(passShouldStop("queue_unwritable"), true);
  assert.equal(passShouldStop("unknown_item"), true);
});

test("陈旧判定看身份对，不看进程在不在", () => {
  const receipt = receiptOf(job(), { outcome: "completed" }, 1_000, 2_000, WORKER);
  const fresh = (_pid: number): number | undefined => 900;
  const reused = (_pid: number): number | undefined => 1_500;
  const gone = (_pid: number): number | undefined => undefined;

  // pid 还活着但启动时间对不上 —— 那是另一个进程顶了这个 pid，回执不可信。
  assert.equal(receiptIsStale(receipt, fresh), false);
  assert.equal(receiptIsStale(receipt, reused), true);
  assert.equal(receiptIsStale(receipt, gone), true);
});

test("预算是一个小常数，不是队列长度", () => {
  // 有牙：预算若取自队列长度，一个 100 条的队列会让一个 tick 跑 100 轮。
  assert.ok(DEFAULT_WORKER_BUDGET > 0);
  assert.ok(DEFAULT_WORKER_BUDGET <= 10);
});
