import assert from "node:assert/strict";
import { test } from "node:test";
import { outcomeOfTurn, workerTurnRequest } from "./loop-executor.js";
import { initialState, type ExecutionState } from "../../domain/state.js";
import type { WorkerJob } from "../../ports/worker.js";

/**
 * 执行 owner 的两条规则，各针对一处「写错了也不会报错」的地方。
 *
 * 这一批的来由是实测：真 provider 收到 `model:"default"` 回 404。夹具 provider
 * 不看 model，所以离线那组全绿把它盖住了 —— 因此这里**必须**有一条把 model
 * 钉死的测试，否则同一件事会再发生一次。
 */

const JOB: WorkerJob = {
  sessionId: "sess_1",
  messageId: "msg_1",
  text: "write the file",
  enqueuedAtMs: 1_000,
};

function state(
  phase: ExecutionState["phase"],
  terminalReason?: ExecutionState["terminalReason"],
): ExecutionState {
  return {
    ...initialState(),
    phase,
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
}

test("the turn request carries the wired model, not a placeholder", () => {
  const request = workerTurnRequest(JOB, {
    model: "MiMo-V2.6-Flash",
    now: () => 1_000,
    newId: (prefix) => `${prefix}_x`,
  });
  assert.equal(request.model, "MiMo-V2.6-Flash");
});

test("the turn request carries the job's session, text and a fresh turn id", () => {
  const request = workerTurnRequest(JOB, {
    model: "m",
    now: () => 7,
    newId: (prefix) => `${prefix}_42`,
  });

  assert.equal(request.sessionId, "sess_1");
  assert.equal(request.text, "write the file");
  assert.equal(request.turnId, "turn_42");
  assert.equal(request.correlationId, "corr_42");
  assert.equal(request.now?.(), 7);
});

test("an empty model is passed through rather than silently defaulted here", () => {
  // 空字符串要原样传下去：这个文件的职责不是替组合根补一个模型名（那会把
  // 「没配模型」伪装成「配了一个叫 default 的模型」）。组合根在装配时就拒。
  const request = workerTurnRequest(JOB, { model: "", now: () => 0, newId: (p) => p });
  assert.equal(request.model, "");
});

test("a terminal turn maps its reason straight through", () => {
  assert.equal(outcomeOfTurn(state("terminal", "completed")), "completed");
  assert.equal(outcomeOfTurn(state("terminal", "failed")), "failed");
  assert.equal(outcomeOfTurn(state("terminal", "cancelled")), "cancelled");
});

test("a terminal turn with an unlisted reason is unknown, not failed", () => {
  assert.equal(outcomeOfTurn(state("terminal", "unknown")), "unknown");
});

test("a turn that never reached a terminal phase is unknown, never failed", () => {
  // 「没走到终态」意味着副作用可能已经落了，所以它是 unknown 而不是 failed：
  // failed 会让人以为可以安全重跑。
  for (const phase of ["idle", "turning", "streaming", "tooling", "approval_waiting"] as const) {
    assert.equal(outcomeOfTurn(state(phase)), "unknown", `phase ${phase}`);
  }
});
