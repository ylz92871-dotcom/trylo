import assert from "node:assert/strict";
import { test } from "node:test";
import { DAILY_PROPOSAL_LIMIT, PER_TOOL_PROPOSALS_PER_RUN, PROPOSAL_COOLDOWN_MS } from "./constants.js";
import { admitProposal, type ProposalRecord } from "./throttle.js";

/**
 * 频控（规格 §5）：三条闸，一条都不能少。
 *
 * 闸门存在的理由是「提议一次就要人点一次」。没有它，一个反复失败的工具会在每个
 * run 里各提一次，几轮下来用户面对的就是同一句话刷屏——**提议的价值在于它稀有**。
 *
 * 三条闸的判据维度刻意不同：冷却按**提议身份**（同一件事 7 天内只提一次），
 * 每-run 上限按**工具**（一个工具一个 run 最多一条），日上限按**全局**（今天最多
 * 三条）。同一件事、同一个工具、同一天——三个不同的计数单位，所以三条都要在。
 */

const DAY = 24 * 60 * 60 * 1000;

function record(key: string, tool: string, runId: string, at: string): ProposalRecord {
  return { key, tool, runId, proposedAt: at };
}

const NOW = "2026-09-17T12:00:00.000Z";

test("H1 没有历史 → 放行", () => {
  const verdict = admitProposal({
    candidate: { key: "improve:run_shell", tool: "run_shell" },
    runId: "run-1",
    at: NOW,
    history: [],
  });
  assert.deepEqual(verdict, { allowed: true });
});

test("H2 同一件事在冷却期内 → 拒（cooldown）", () => {
  const verdict = admitProposal({
    candidate: { key: "improve:run_shell", tool: "run_shell" },
    runId: "run-2",
    at: NOW,
    history: [record("improve:run_shell", "run_shell", "run-1", "2026-09-13T12:00:00.000Z")],
  });

  assert.equal(verdict.allowed, false);

  if (verdict.allowed) {
    return;
  }

  assert.equal(verdict.reason, "cooldown");
});

test("H3 过了冷却期 → 放行（冷却不是终身禁言）", () => {
  const justOver = new Date(Date.parse(NOW) - PROPOSAL_COOLDOWN_MS - 1000).toISOString();
  const verdict = admitProposal({
    candidate: { key: "improve:run_shell", tool: "run_shell" },
    runId: "run-2",
    at: NOW,
    history: [record("improve:run_shell", "run_shell", "run-1", justOver)],
  });

  assert.deepEqual(verdict, { allowed: true });
});

test("H4 同一工具在同一 run 内第二条 → 拒（per_tool_per_run）", () => {
  const verdict = admitProposal({
    candidate: { key: "replace:run_shell", tool: "run_shell" },
    runId: "run-1",
    at: NOW,
    history: [record("improve:run_shell", "run_shell", "run-1", "2026-01-01T00:00:00.000Z")],
  });

  assert.equal(verdict.allowed, false);

  if (verdict.allowed) {
    return;
  }

  assert.equal(verdict.reason, "per_tool_per_run");
});

test("H5 同一工具换一个 run → 放行（每-run 上限按 run 计数，不按工具终身计数）", () => {
  const verdict = admitProposal({
    candidate: { key: "replace:run_shell", tool: "run_shell" },
    runId: "run-2",
    at: NOW,
    history: [
      record("improve:run_shell", "run_shell", "run-1", "2026-01-01T00:00:00.000Z"),
      record("replace:run_shell", "run_shell", "run-1", "2026-01-01T00:00:01.000Z"),
    ],
  });
  assert.deepEqual(verdict, { allowed: true });
});

test("H6 当天第三条之后 → 拒（daily_limit）", () => {
  const history = [
    record("a", "tool_a", "run-9", "2026-09-17T01:00:00.000Z"),
    record("b", "tool_b", "run-9", "2026-09-17T02:00:00.000Z"),
    record("c", "tool_c", "run-9", "2026-09-17T03:00:00.000Z"),
  ];

  assert.equal(history.length, DAILY_PROPOSAL_LIMIT);
  const verdict = admitProposal({
    candidate: { key: "d", tool: "tool_d" },
    runId: "run-9",
    at: NOW,
    history,
  });

  assert.equal(verdict.allowed, false);

  if (verdict.allowed) {
    return;
  }

  assert.equal(verdict.reason, "daily_limit");
});

test("H7 昨天的不占今天的额度", () => {
  const history = [
    record("a", "tool_a", "run-9", "2026-09-16T01:00:00.000Z"),
    record("b", "tool_b", "run-9", "2026-09-16T02:00:00.000Z"),
    record("c", "tool_c", "run-9", "2026-09-16T03:00:00.000Z"),
  ];
  const verdict = admitProposal({
    candidate: { key: "d", tool: "tool_d" },
    runId: "run-10",
    at: NOW,
    history,
  });

  assert.deepEqual(verdict, { allowed: true });
});

test("H8 时间读不出来 → 拒（频控不许 fail open）", () => {
  const verdict = admitProposal({
    candidate: { key: "improve:run_shell", tool: "run_shell" },
    runId: "run-1",
    at: "not-a-time",
    history: [],
  });

  assert.equal(verdict.allowed, false);

  if (verdict.allowed) {
    return;
  }

  assert.equal(verdict.reason, "invalid_time");

  // 账本里的一行坏时间同样 fail closed：坏账说明别处已经出事了，此时少提一次
  // 比多提一次安全。
  const dirtyLedger = admitProposal({
    candidate: { key: "improve:run_shell", tool: "run_shell" },
    runId: "run-1",
    at: NOW,
    history: [record("improve:run_shell", "run_shell", "run-1", "nonsense")],
  });

  assert.equal(dirtyLedger.allowed, false);

  if (!dirtyLedger.allowed) {
    assert.equal(dirtyLedger.reason, "invalid_time");
  }
});

test("H9 三条同时命中时，理由取冷却（判据优先级：冷却 → 每-run → 日上限）", () => {
  const history = [
    record("improve:run_shell", "run_shell", "run-1", "2026-09-17T11:00:00.000Z"),
    record("x", "tool_x", "run-1", "2026-09-17T01:00:00.000Z"),
    record("y", "tool_y", "run-1", "2026-09-17T02:00:00.000Z"),
    record("z", "tool_z", "run-1", "2026-09-17T03:00:00.000Z"),
  ];
  const verdict = admitProposal({
    candidate: { key: "improve:run_shell", tool: "run_shell" },
    runId: "run-1",
    at: NOW,
    history,
  });

  assert.equal(verdict.allowed, false);

  if (verdict.allowed) {
    return;
  }

  assert.equal(verdict.reason, "cooldown");
});

test("H10 常量口径：每工具每 run 一条、全局每天三条", () => {
  assert.equal(PER_TOOL_PROPOSALS_PER_RUN, 1);
  assert.equal(DAILY_PROPOSAL_LIMIT, 3);
  assert.equal(PROPOSAL_COOLDOWN_MS / DAY, 7);
});
