import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAILY_PROPOSAL_LIMIT,
  PER_TOOL_PROPOSALS_PER_RUN,
  PROPOSAL_COOLDOWN_MS,
  TOOL_FAILURE_THRESHOLD,
} from "./constants.js";
import { tallyToolFailures, toolsAtOrOverThreshold } from "./failure-stats.js";
import { observationKindFor, observationsFromFailures } from "./gap-adapt.js";
import { parseSelfReport } from "./self-report.js";
import { assessToolAwareness, objectiveSignalOf } from "./corroboration.js";
import { DEFAULT_GAP_POLICY } from "../gap-detector.js";
import type { FailureFact, TaskScope } from "./types.js";

/**
 * 意识层的合同（P05 工具学习规格 §2 + TP-1 施工包 TP1-1）。
 *
 * 这一层只回答一个问题：**「工具不够」这件事，什么时候算被意识到了？**
 * 答案是规格 §2 的佐证规则——客观证据 × 模型自己的话，两边互相校准，谁都不能
 * 单独触发。下面每一组用例对应规格里的一条硬门，注释里写的是「它为什么在这里」
 * 而不是「它测了什么」。
 */

const scope: TaskScope = {
  taskFamily: "pdf-extract",
  capability: "extract-text-from-pdf",
  criticality: "normal",
  fallbackAvailable: true,
};

function fact(tool: string, code = "tool_error", fingerprint = "fp"): FailureFact {
  return { tool, code, fingerprint };
}

function repeat(times: number, tool: string, code = "tool_error"): FailureFact[] {
  return Array.from({ length: times }, () => fact(tool, code));
}

// ── 常量：规格 §13 的定稿值，全部命名、一处导出（反方：任何人不得就地写魔数） ──

test("A1 频控与阈值常量是规格 §13 定稿的那几个值", () => {
  assert.equal(TOOL_FAILURE_THRESHOLD, 3);
  assert.equal(PROPOSAL_COOLDOWN_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(DAILY_PROPOSAL_LIMIT, 3);
  assert.equal(PER_TOOL_PROPOSALS_PER_RUN, 1);
});

test("A2 源① 的阈值与 gap-detector 的重复阈值是两个量，谁都不许顶替谁", () => {
  // 源① 数的是「同一个工具在本 run 内失败了几次」（工具维度）。
  assert.equal(TOOL_FAILURE_THRESHOLD, 3);
  // 源② 数的是「同一个 taskFamily+capability 组里失败了几条 observation」（事维度）。
  assert.equal(DEFAULT_GAP_POLICY.repeatThreshold, 3);
  // 两者数值相同是巧合而不是同一件事：下面 B3/C1 用同一条失败流分别验证两条路
  // 各自独立生效（工具维度先饱和，事维度也要能单独判）。
  assert.equal(typeof DEFAULT_GAP_POLICY.highCriticalityThreshold, "number");
});

// ── 源① 客观失败统计：聚合器 ──

test("B1 同一工具到阈值才入榜，工具维度不是事维度", () => {
  const tallies = tallyToolFailures(repeat(3, "run_shell"));
  assert.equal(tallies.length, 1);
  assert.equal(tallies[0]?.tool, "run_shell");
  assert.equal(tallies[0]?.failures, 3);
  assert.equal(toolsAtOrOverThreshold(tallies).length, 1);
});

test("B2 差一次就不入榜（反例：两次失败自动换工具）", () => {
  const tallies = tallyToolFailures(repeat(2, "run_shell"));
  assert.equal(tallies[0]?.failures, 2);
  assert.deepEqual(toolsAtOrOverThreshold(tallies), []);
});

test("B3 阈值是形参，可被调用方覆盖但默认永远是命名常量", () => {
  const tallies = tallyToolFailures(repeat(2, "run_shell"));
  assert.equal(toolsAtOrOverThreshold(tallies).length, 0);
  assert.equal(toolsAtOrOverThreshold(tallies, 2).length, 1);
});

test("B4 聚合结果确定：按工具名排序，失败码去重且保序", () => {
  const facts = [
    fact("b_tool", "code_e"),
    fact("a_tool", "code_z"),
    fact("b_tool", "code_a"),
    fact("a_tool", "code_z"),
  ];
  const tallies = tallyToolFailures(facts);

  assert.deepEqual(
    tallies.map((item) => item.tool),
    ["a_tool", "b_tool"],
  );
  assert.deepEqual(tallies[0]?.codes, ["code_z"]);
  assert.deepEqual(tallies[1]?.codes, ["code_e", "code_a"]);
  assert.equal(tallies[1]?.failures, 2);
});

test("B5 空输入不炸，也不凭空造出信号", () => {
  assert.deepEqual(tallyToolFailures([]), []);
  assert.deepEqual(toolsAtOrOverThreshold([]), []);
});

// ── 源② 缺口检测：从拍级失败事实到 observation 的适配 ──

test("C1 失败码映射到 observation 种类，缺省是 tool_failure", () => {
  assert.equal(observationKindFor("unknown_tool"), "tool_not_found");
  assert.equal(observationKindFor("tool_not_found"), "tool_not_found");
  assert.equal(observationKindFor("ENOENT"), "platform_incompatible");
  assert.equal(observationKindFor("EFTYPE"), "platform_incompatible");
  assert.equal(observationKindFor("invalid_arguments"), "schema_friction");
  assert.equal(observationKindFor("tool_error"), "tool_failure");
  assert.equal(observationKindFor("something_else"), "tool_failure");
});

test("C2 缺 taskFamily 或 capability 是非法输入，不搜索不下载", () => {
  const bad = { ...scope, capability: "" };
  const result = observationsFromFailures(repeat(3, "run_shell"), bad, "2026-09-17T00:00:00Z");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_scope");
  }
});

test("C3 重复保留：三条同类失败必须仍是三条 observation，否则数不出重复", () => {
  const result = observationsFromFailures(repeat(3, "run_shell"), scope, "2026-09-17T00:00:00Z");

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.length, 3);
  const ids = new Set(result.value.map((item) => item.observationId));

  assert.equal(ids.size, 3, "observationId 必须逐条唯一，否则缺口检测数不出重复");
  assert.deepEqual(
    result.value.map((item) => item.kind),
    ["tool_failure", "tool_failure", "tool_failure"],
  );
  assert.deepEqual(
    result.value.map((item) => item.capability),
    [scope.capability, scope.capability, scope.capability],
  );
  assert.deepEqual(
    result.value.map((item) => item.toolName),
    ["run_shell", "run_shell", "run_shell"],
  );
});

// ── 源② 与既有 gap-detector 的桥接 ──

test("D1 三条同族失败经适配后命中缺口检测（事维度）", () => {
  const adapted = observationsFromFailures(repeat(3, "run_shell"), scope, "2026-09-17T00:00:00Z");

  assert.equal(adapted.ok, true);

  if (!adapted.ok) {
    return;
  }

  const signal = objectiveSignalOf(adapted.value, repeat(3, "run_shell"));

  assert.equal(signal.ok, true);

  if (!signal.ok) {
    return;
  }

  assert.notEqual(signal.value, undefined);
});

test("D2 两条同族失败低于重复阈值，不产生客观信号", () => {
  const adapted = observationsFromFailures(repeat(2, "run_shell"), scope, "2026-09-17T00:00:00Z");

  assert.equal(adapted.ok, true);

  if (!adapted.ok) {
    return;
  }

  const signal = objectiveSignalOf(adapted.value, repeat(2, "run_shell"));

  assert.equal(signal.ok, true);

  if (!signal.ok) {
    return;
  }

  assert.equal(signal.value, undefined, "两次失败 = 这次没成，不是工具不行");
});

// ── 源③ 自报解析：坏的一律不许变成提议 ──

test("E1 规格 §2 的两种自报原文都能解析", () => {
  const newTool = parseSelfReport({ need: "新工具:能做PDF表格抽取" });
  assert.deepEqual(newTool, { kind: "new_tool", need: "能做PDF表格抽取" });

  const improve = parseSelfReport({ need: "改进:工具run_shell描述总让我用错", tool: "run_shell" });
  assert.deepEqual(improve, { kind: "improve_tool", tool: "run_shell", need: "工具run_shell描述总让我用错" });
});

test("E2 坏自报一律解析成 undefined（围栏空/坏 JSON 不许当提议）", () => {
  assert.equal(parseSelfReport(undefined), undefined);
  assert.equal(parseSelfReport(null), undefined);
  assert.equal(parseSelfReport("not json"), undefined);
  assert.equal(parseSelfReport([{ need: "新工具:x" }]), undefined);
  assert.equal(parseSelfReport({}), undefined);
  assert.equal(parseSelfReport({ need: "" }), undefined);
  assert.equal(parseSelfReport({ need: "  " }), undefined);
  assert.equal(parseSelfReport({ need: 42 }), undefined);
  assert.equal(parseSelfReport({ need: "随手写的感想" }), undefined, "前缀不认识 = 不是自报");
  assert.equal(parseSelfReport({ need: "改进:描述有问题" }), undefined, "improve 少了 tool 就不可行动");
  assert.equal(parseSelfReport({ need: "改进:描述有问题", tool: "" }), undefined);
  assert.equal(parseSelfReport({ need: "新工具:" }), undefined, "冒号后为空不算需求");
});

// ── 佐证规则（规格 §2 的硬门，本层存在的理由） ──

const T = "2026-09-17T00:00:00Z";

test("F1 自报 + 客观佐证 → 进提议队列", () => {
  const outcome = assessToolAwareness({
    failures: repeat(3, "run_shell"),
    scope,
    recordedAt: T,
    selfReport: { need: "改进:描述总让我用错", tool: "run_shell" },
  });

  assert.equal(outcome.kind, "proposal");

  if (outcome.kind !== "proposal") {
    return;
  }

  assert.equal(outcome.report.kind, "improve_tool");
});

test("F2 反例：自报单独不触发任何提议", () => {
  const outcome = assessToolAwareness({
    failures: repeat(2, "run_shell"),
    scope,
    recordedAt: T,
    selfReport: { need: "改进:描述总让我用错", tool: "run_shell" },
  });

  assert.equal(outcome.kind, "observation");

  if (outcome.kind !== "observation") {
    return;
  }

  assert.equal(outcome.reason, "no_objective_signal");
});

test("F3 客观满足而模型没报 → 只记 observation，不提议", () => {
  const outcome = assessToolAwareness({
    failures: repeat(3, "run_shell"),
    scope,
    recordedAt: T,
  });

  assert.equal(outcome.kind, "observation");

  if (outcome.kind !== "observation") {
    return;
  }

  assert.equal(outcome.reason, "no_self_report");
});

test("F4 客观满足而围栏坏了 → 与没报同一种事实（observation，不是 proposal）", () => {
  const outcome = assessToolAwareness({
    failures: repeat(4, "run_shell"),
    scope,
    recordedAt: T,
    selfReport: { need: "模型说了半句围栏" },
  });
  assert.equal(outcome.kind, "observation");
});

test("F5 两边都没有 → 静默（不许无证据地自言自语）", () => {
  const outcome = assessToolAwareness({ failures: [], scope, recordedAt: T });
  assert.equal(outcome.kind, "silent");
});

test("F6 缺口类信号优先于失败类：没有工具能做 X 比工具有但用错更根本", () => {
  const facts = repeat(3, "run_shell", "unknown_tool");
  const outcome = assessToolAwareness({
    failures: facts,
    scope,
    recordedAt: T,
    selfReport: { need: "新工具:能做PDF表格抽取" },
  });

  assert.equal(outcome.kind, "proposal");

  if (outcome.kind !== "proposal") {
    return;
  }

  if (outcome.signal.kind !== "gap") {
    assert.fail(`expected a gap-class signal, got ${outcome.signal.kind}`);
  }

  assert.equal(outcome.signal.gap.kind, "tool_not_found");
});

test("F7 纯失败类信号落到 failure，供决策树走 A 轻升级那支", () => {
  const facts = repeat(3, "run_shell", "tool_error");
  const outcome = assessToolAwareness({
    failures: facts,
    scope,
    recordedAt: T,
    selfReport: { need: "改进:描述总让我用错", tool: "run_shell" },
  });

  assert.equal(outcome.kind, "proposal");

  if (outcome.kind !== "proposal") {
    return;
  }

  if (outcome.signal.kind !== "failure") {
    assert.fail(`expected a failure-class signal, got ${outcome.signal.kind}`);
  }

  assert.equal(outcome.signal.tally.tool, "run_shell");
});

test("F8 提议里带得住证据引用：observationIds 非空（规格 §9 提议形状）", () => {
  const outcome = assessToolAwareness({
    failures: repeat(3, "run_shell"),
    scope,
    recordedAt: T,
    selfReport: { need: "改进:描述总让我用错", tool: "run_shell" },
  });

  assert.equal(outcome.kind, "proposal");

  if (outcome.kind !== "proposal") {
    return;
  }

  assert.equal(outcome.evidenceRefs.length > 0, true);
});
