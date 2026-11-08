import assert from "node:assert/strict";
import { test } from "node:test";
import { decideProposalAction } from "./decision.js";
import { CRYSTAL_MIN_SUCCESSES } from "./constants.js";
import type { ObjectiveSignal, SelfReport, TaskScope } from "./types.js";
import { observationsFromFailures } from "./gap-adapt.js";
import { objectiveSignalOf } from "./corroboration.js";
import type { FailureFact } from "./types.js";

/**
 * 决策树（规格 §5）：换还是升级，**确定性判定，不跑 LLM**。
 *
 * 规格把两支写死了：
 *
 * - 缺口类信号（没有工具能做 X）→ 提议「换/新增」；
 * - 失败类信号（工具 Y 在但老用错）→ 先试轻升级（A 描述精炼）；
 *   A 已做过、仍有失败 → 提议「换 Y」或「重升级」（B 结晶一个替代）。
 *
 * 这一支的分法不是口味问题：对「没有工具能用」去精炼一个不存在的描述是白费力气，
 * 对「描述让我用错」去换个新工具也是白换。用例逐支钉住它。
 */

const scope: TaskScope = {
  taskFamily: "pdf-extract",
  capability: "extract-text-from-pdf",
  criticality: "normal",
  fallbackAvailable: true,
};

function fact(tool: string, code = "tool_error"): FailureFact {
  return { tool, code, fingerprint: "fp" };
}

function repeat(times: number, tool: string, code = "tool_error"): FailureFact[] {
  return Array.from({ length: times }, () => fact(tool, code));
}

function signalOf(facts: readonly FailureFact[]): ObjectiveSignal {
  const adapted = observationsFromFailures(facts, scope, "2026-09-17T00:00:00Z");

  assert.equal(adapted.ok, true);

  if (!adapted.ok) {
    assert.fail("scope must be valid");
  }

  const signal = objectiveSignalOf(adapted.value, facts);

  assert.equal(signal.ok, true);

  if (!signal.ok || signal.value === undefined) {
    assert.fail("expected an objective signal");
  }

  return signal.value;
}

const improve: SelfReport = { kind: "improve_tool", tool: "run_shell", need: "描述总让我用错" };

test("G1 缺口类 → 换/新增（去候选获取层找），不走 A", () => {
  const action = decideProposalAction({
    signal: signalOf(repeat(3, "run_shell", "unknown_tool")),
    report: improve,
    refinementAttemptedFor: [],
    successfulTrajectories: 0,
  });
  assert.equal(action.kind, "replace_or_add");
});

test("G2 失败类且 A 没做过 → 先试轻升级（描述精炼）", () => {
  const action = decideProposalAction({
    signal: signalOf(repeat(3, "run_shell")),
    report: improve,
    refinementAttemptedFor: [],
    successfulTrajectories: 0,
  });

  assert.equal(action.kind, "light_upgrade");

  if (action.kind !== "light_upgrade") {
    return;
  }

  assert.equal(action.tool, "run_shell");
});

test("G3 失败类、A 已做过、没有可结晶的成功轨迹 → 换 Y", () => {
  const action = decideProposalAction({
    signal: signalOf(repeat(3, "run_shell")),
    report: improve,
    refinementAttemptedFor: ["run_shell"],
    successfulTrajectories: CRYSTAL_MIN_SUCCESSES - 1,
  });
  assert.equal(action.kind, "replace_tool");
});

test("G4 失败类、A 已做过、成功轨迹够 → 重升级（B 结晶一个替代）", () => {
  const action = decideProposalAction({
    signal: signalOf(repeat(3, "run_shell")),
    report: improve,
    refinementAttemptedFor: ["run_shell"],
    successfulTrajectories: CRYSTAL_MIN_SUCCESSES,
  });
  assert.equal(action.kind, "heavy_upgrade");
});

test("G5 A 只对「做过的那一个工具」算做过，别的工具仍走轻升级", () => {
  const action = decideProposalAction({
    signal: signalOf(repeat(3, "run_shell")),
    report: improve,
    refinementAttemptedFor: ["grep_files"],
    successfulTrajectories: 99,
  });
  assert.equal(action.kind, "light_upgrade");
});

test("G6 决策是纯函数：同一输入两次同结果，且不依赖任何 IO", () => {
  const input = {
    signal: signalOf(repeat(3, "run_shell")),
    report: improve,
    refinementAttemptedFor: ["run_shell"],
    successfulTrajectories: 0,
  };
  assert.deepEqual(decideProposalAction(input), decideProposalAction(input));
});

test("G7 两支都被覆盖：gap 类不返回任何升级动作，failure 类不返回 replace_or_add", () => {
  const gapAction = decideProposalAction({
    signal: signalOf(repeat(3, "run_shell", "unknown_tool")),
    report: improve,
    refinementAttemptedFor: ["run_shell"],
    successfulTrajectories: 99,
  });

  assert.equal(gapAction.kind, "replace_or_add");

  const failureAction = decideProposalAction({
    signal: signalOf(repeat(3, "run_shell")),
    report: improve,
    refinementAttemptedFor: [],
    successfulTrajectories: 0,
  });

  assert.notEqual(failureAction.kind, "replace_or_add");
});
