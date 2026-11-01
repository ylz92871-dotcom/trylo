import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolGapRuntime,
  instruction,
  type ToolLedgerPort,
  type ToolLedgerRecord,
} from "./index.js";
import { proposalHistoryOf } from "./ledger-file.js";
import type { ToolGapPort as LearningToolGapPort, ObservedFailureFact } from "../../learning/domains/tool/awareness/port.js";
import { TOOL_GAP_FENCE } from "../../learning/domains/tool/awareness/port.js";
import {
  LEARNING_SWITCH_VALUES,
  LEARNING_SWITCHES,
  isLearningSwitch,
  switchEnablesTool,
} from "../user-learning/index.js";

/**
 * 意识层通电（P05 工具学习 TP-1 的第一次通电）。
 *
 * 这一组用例问的是「接线接上了没有、接上之后行为对不对」，不是「零件对不对」——
 * 零件的判定在 `learning/domains/tool/awareness/` 那一组里。这里只关心三件事：
 *
 *  - **开关的口子在哪儿**：只有 `all` 才点亮工具学习，缺省与另两个取值都不点。
 *  - **一拍之内不联网、不写盘以外的东西**：`observe` 只做纯判定 + 追加一条账。
 *  - **结局都要留痕**：observation / proposal / throttled 三种都进账，因为
 *    「这个工具有问题却没提议」是最需要能被追问的那种情况。
 *
 * 账用内存假件，所以没有一条用例碰文件系统。
 */

type MemoryLedger = {
  readonly records: ToolLedgerRecord[];
  readonly port: ToolLedgerPort;
};

function memoryLedger(seed: readonly ToolLedgerRecord[] = []): MemoryLedger {
  const records: ToolLedgerRecord[] = [...seed];
  return {
    records,
    port: {
      append: async (record) => {
        records.push(record);
      },
      tail: async () => [...records],
    },
  };
}

function failure(tool: string, code = "tool_error"): ObservedFailureFact {
  return { tool, code, fingerprint: "fp" };
}

function runtimeOf(options: { readonly seed?: readonly ToolLedgerRecord[] } = {}): {
  readonly runtime: ReturnType<typeof createToolGapRuntime>;
  readonly ledger: MemoryLedger;
  readonly warnings: string[];
} {
  const ledger = memoryLedger(options.seed ?? []);
  const warnings: string[] = [];
  const runtime = createToolGapRuntime({
    ledger: ledger.port,
    now: () => Date.parse("2026-09-17T12:00:00.000Z"),
    warn: (message) => {
      warnings.push(message);
    },
  });
  return { runtime, ledger, warnings };
}

const IMPROVE = JSON.stringify({ need: "改进:描述总让我用错", tool: "run_shell" });
const NEW_TOOL = JSON.stringify({ need: "新工具:能做PDF表格抽取" });

// ── 开关：只有 all 点亮，缺省永远不点亮 ──

test("Q1 工具学习有自己的取值；缺省与另两个取值都不点亮它", () => {
  assert.equal(switchEnablesTool(undefined), false, "关学习永远不含工具学习");
  assert.equal(switchEnablesTool("method"), false);
  assert.equal(switchEnablesTool("user"), false);
  assert.equal(switchEnablesTool("tool"), true);
  assert.equal(switchEnablesTool("all"), true);
});

test("Q1b 闭集四个成员，帮助文本由闭集自己算（没有第二份枚举）", () => {
  assert.deepEqual([...LEARNING_SWITCHES], ["method", "user", "tool", "all"]);
  assert.equal(LEARNING_SWITCH_VALUES, "method|user|tool|all");
  assert.equal(isLearningSwitch("tool"), true);
  assert.equal(isLearningSwitch("tools"), false, "拼错仍是用法错，不静默降级");
});

test("Q2 请模型自报的那段话里带着围栏标记与两种写法（固定字符串）", () => {
  const text = instruction();
  assert.equal(text.includes(TOOL_GAP_FENCE), true);
  assert.equal(text.includes("新工具:"), true);
  assert.equal(text.includes("改进:"), true);
  assert.equal(text, instruction(), "它必须是固定字符串，不是每次现编的话");
});

// ── intentOn：有客观证据才要围栏 ──

test("Q3 一次失败就要围栏是错的：不到阈值不 intent", async () => {
  const { runtime } = runtimeOf();
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
  });
  // 两拍之后仍然只有两次失败。
  await runtime.port.observe({ turnId: "t1", beat: 2, failures: [], toolNames: ["run_shell"] });
  assert.equal(runtime.port.intentOn("t1", 3), false);
});

test("Q4 失败累积到阈值后 intent 打开；没见过的 turn 永远是关的", async () => {
  const { runtime } = runtimeOf();
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
  });
  assert.equal(runtime.port.intentOn("t1", 2), true);
  assert.equal(runtime.port.intentOn("t-other", 1), false);
});

test("Q5 不 intent 时不注入任何提示（不给模型塞空话）", async () => {
  const { runtime } = runtimeOf();
  const quiet = await runtime.port.requestPrompt({ turnId: "t1", beat: 1, toolNames: [] });
  assert.equal(quiet, undefined);
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
  });
  const asked = await runtime.port.requestPrompt({ turnId: "t1", beat: 2, toolNames: ["run_shell"] });
  assert.equal(asked?.role, "system");
});

// ── observe：三种结局都留痕 ──

test("Q6 自报 + 客观佐证 → 提议进账，且给用户一行", async () => {
  const { runtime, ledger, warnings } = runtimeOf();
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
    selfReport: IMPROVE,
  });
  const proposals = ledger.records.filter((record) => record.kind === "proposal");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.action, "light_upgrade");
  assert.equal(proposals[0]?.tool, "run_shell");
  assert.equal(warnings.length, 1);
  assert.equal(runtime.proposals().length, 1);
});

test("Q6b 多工具失败时只改达到门槛的工具，不把全部失败归给第一个工具", async () => {
  const { runtime, ledger, warnings } = runtimeOf();
  await runtime.port.observe({
    turnId: "t-mixed",
    beat: 1,
    failures: [failure("tool_A"), failure("tool_Z"), failure("tool_Z"), failure("tool_Z")],
    toolNames: ["tool_A", "tool_Z"],
    selfReport: JSON.stringify({ need: "改进:参数说明不清楚", tool: "tool_Z" }),
  });
  const proposal = ledger.records.find((record) => record.kind === "proposal");
  assert.equal(proposal?.tool, "tool_Z");
  assert.equal(proposal?.key, "light_upgrade:tool_Z");
  assert.equal(runtime.proposals()[0]?.tool, "tool_Z");
  assert.equal(warnings[0]?.includes("tool_Z"), true);
});

test("Q6c 提议详情保留选中的完整信号、自报与证据，读取快照不能改写后续判断", async () => {
  const { runtime } = runtimeOf();
  await runtime.port.observe({
    turnId: "t-details",
    beat: 1,
    failures: [failure("tool_A"), failure("tool_Z"), failure("tool_Z"), failure("tool_Z")],
    toolNames: ["tool_A", "tool_Z"],
    selfReport: JSON.stringify({ need: "改进:参数说明不清楚", tool: "tool_Z" }),
  });
  const snapshot = runtime.proposalDetails();
  const detail = snapshot[0];
  assert.ok(detail);
  assert.deepEqual(detail.record, runtime.proposals()[0]);
  assert.deepEqual(detail.signal, {
    kind: "failure",
    tally: { tool: "tool_Z", failures: 3, codes: ["tool_error"], fingerprints: ["fp"] },
  });
  assert.deepEqual(detail.selfReport, { kind: "improve_tool", tool: "tool_Z", need: "参数说明不清楚" });
  assert.deepEqual(detail.action, { kind: "light_upgrade", tool: "tool_Z" });
  assert.deepEqual(detail.evidenceRefs, [
    "obs:tool_A:tool_error:fp:0", "obs:tool_Z:tool_error:fp:1",
    "obs:tool_Z:tool_error:fp:2", "obs:tool_Z:tool_error:fp:3",
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  Object.defineProperty(detail.scope, "capability", { value: "外部修改" });
  assert.equal(runtime.proposalDetails()[0]?.scope.capability, "参数说明不清楚");
  await runtime.close();
  assert.deepEqual(runtime.proposalDetails(), []);
});

test("Q7 反例：自报单独来（失败不到阈值）→ 只记 observation，不提议", async () => {
  const { runtime, ledger, warnings } = runtimeOf();
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
    selfReport: IMPROVE,
  });
  assert.deepEqual(
    ledger.records.map((record) => record.kind),
    ["observation"],
  );
  assert.equal(ledger.records[0]?.reason, "no_objective_signal");
  assert.deepEqual(warnings, []);
  assert.deepEqual(runtime.proposals(), []);
});

test("Q8 客观够了而模型没报 → 只记 observation", async () => {
  const { runtime, ledger, warnings } = runtimeOf();
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
  });
  assert.deepEqual(
    ledger.records.map((record) => record.kind),
    ["observation"],
  );
  assert.equal(ledger.records[0]?.reason, "no_self_report");
  assert.deepEqual(warnings, []);
});

test("Q9 坏自报（不是 JSON / 前缀不认识）与没自报同一种事实", async () => {
  const bad = runtimeOf();
  await bad.runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
    selfReport: "模型说了半句围栏",
  });
  assert.equal(bad.ledger.records[0]?.kind, "observation");

  const unknown = runtimeOf();
  await unknown.runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
    selfReport: JSON.stringify({ need: "随手写的感想" }),
  });
  assert.equal(unknown.ledger.records[0]?.kind, "observation");
  assert.deepEqual(unknown.runtime.proposals(), []);
});

test("Q10 缺口类信号（没有工具能做）走 replace_or_add，提议里没有具体工具", async () => {
  const { runtime, ledger } = runtimeOf();
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell", "unknown_tool"), failure("run_shell", "unknown_tool"), failure("run_shell", "unknown_tool")],
    toolNames: ["run_shell"],
    selfReport: NEW_TOOL,
  });
  const proposal = ledger.records.find((record) => record.kind === "proposal");
  assert.equal(proposal?.action, "replace_or_add");
  assert.equal(proposal?.tool, undefined);
  assert.equal(proposal?.capability, "能做PDF表格抽取");
});

test("Q10b 缺工具的客观证据不会被描述改进自报改写成轻升级", async () => {
  const { runtime, ledger } = runtimeOf();
  await runtime.port.observe({
    turnId: "t-missing",
    beat: 1,
    failures: [failure("run_shell", "unknown_tool"), failure("run_shell", "unknown_tool"), failure("run_shell", "unknown_tool")],
    toolNames: ["run_shell"],
    selfReport: IMPROVE,
  });
  const proposal = ledger.records.find((record) => record.kind === "proposal");
  assert.equal(proposal?.action, "replace_or_add");
  assert.equal(proposal?.tool, undefined);
  const signal = runtime.proposalDetails()[0]?.signal;
  assert.equal(signal?.kind, "gap");
  if (signal?.kind === "gap") {
    assert.equal(signal.gap.kind, "tool_not_found");
    assert.equal(signal.gap.repeatCount, 3);
    assert.equal(signal.gap.observationIds.length, 3);
  }
});

// ── 频控：第二条要留痕，而且不入账为提议 ──

test("Q11 同一提议第二次被冷却拦下：账里仍只有一条提议，但多一条 throttled", async () => {
  const { runtime, ledger, warnings } = runtimeOf();
  const beat = async (n: number): Promise<void> => {
    await runtime.port.observe({
      turnId: "t1",
      beat: n,
      failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
      toolNames: ["run_shell"],
      selfReport: IMPROVE,
    });
  };
  await beat(1);
  await beat(2);
  assert.deepEqual(
    ledger.records.map((record) => record.kind),
    ["proposal", "throttled"],
  );
  assert.equal(ledger.records[1]?.reason, "cooldown");
  assert.equal(warnings.length, 1, "被拦下的那次不该再喊用户一遍");
});

test("Q12 账里的历史可以跨进程复用：上一轮提过的，这一轮直接被冷却拦下", async () => {
  const prior: ToolLedgerRecord = {
    kind: "proposal",
    at: "2026-09-17T11:00:00.000Z",
    turnId: "t-old",
    key: "light_upgrade:run_shell",
    tool: "run_shell",
    action: "light_upgrade",
    capability: "x",
    reason: "y",
  };
  const { runtime, ledger } = runtimeOf({ seed: [prior] });
  await runtime.port.observe({
    turnId: "t-new",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
    selfReport: IMPROVE,
  });
  assert.deepEqual(
    ledger.records.map((record) => record.kind),
    ["proposal", "throttled"],
  );
});

// ── 形状与账的纯函数 ──

test("Q13 运行时的端口就是学习侧那一份（形状可赋值，不见缝插针造第三个类型）", () => {
  const { runtime } = runtimeOf();
  const asLearning: LearningToolGapPort = runtime.port;
  assert.equal(typeof asLearning.intentOn, "function");
  assert.equal(typeof asLearning.observe, "function");
  assert.equal(typeof asLearning.requestPrompt, "function");
});

test("Q14 只有提议进频控历史：observation 与 throttled 都不占额度", () => {
  const records: ToolLedgerRecord[] = [
    { kind: "observation", at: "2026-09-17T01:00:00.000Z", turnId: "t", reason: "no_self_report", detail: "d" },
    { kind: "throttled", at: "2026-09-17T02:00:00.000Z", turnId: "t", key: "k", reason: "cooldown" },
    {
      kind: "proposal",
      at: "2026-09-17T03:00:00.000Z",
      turnId: "t",
      key: "k",
      action: "light_upgrade",
      capability: "x",
      reason: "y",
    },
  ];
  const history = proposalHistoryOf(records);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.key, "k");
  assert.equal("tool" in (history[0] ?? {}), false, "没工具的提议不该塞一个空 tool 键");
});

test("Q15 关掉之后不再记账（close 是幂等收尾，不是又一轮处理）", async () => {
  const { runtime, ledger } = runtimeOf();
  await runtime.close();
  await runtime.port.observe({
    turnId: "t1",
    beat: 1,
    failures: [failure("run_shell"), failure("run_shell"), failure("run_shell")],
    toolNames: ["run_shell"],
    selfReport: IMPROVE,
  });
  assert.deepEqual(ledger.records, []);
});
