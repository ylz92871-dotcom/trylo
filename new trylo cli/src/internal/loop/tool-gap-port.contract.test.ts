import assert from "node:assert/strict";
import test from "node:test";
import { reportToolGapBeat } from "./method-signal.js";
import {
  TOOL_GAP_FENCE as LOOP_FENCE,
  type ToolGapPort as LoopToolGapPort,
  type ToolGapPrompt as LoopToolGapPrompt,
} from "./tool-gap-port.js";
import {
  TOOL_GAP_FENCE as LEARNING_FENCE,
  type ToolGapPort as LearningToolGapPort,
  type ToolGapPrompt as LearningToolGapPrompt,
} from "../learning/agent/subsystems/tool/domain/awareness/port.js";

/**
 * 执行侧与学习侧两份声明的合同。
 *
 * 执行环是冻结核心，不得 import 学习层（`boundary.test.ts` 把任何一条这样的
 * import 判红，而那道门只看**生产**文件），所以两边的声明只能各写一份。这个文件
 * 存在的全部意义是让「声明打架」变成一次**编译错误**：下面三个恒等赋值若不成立，
 * `tsc` 就红，而不是等到某天运行时才发现执行侧上报的字段学习侧根本没读。
 *
 * 围栏标记同理：它在两处各有一份字面量，写得不一致的症状是「模型按学习侧教的
 * 方式写围栏，执行侧一个也认不出来」——一条自报永远抽不出来，而且没有任何一条
 * 别的用例会红。
 */

const portAsLearning: (port: LoopToolGapPort) => LearningToolGapPort = (port) => port;
const learningAsPort: (port: LearningToolGapPort) => LoopToolGapPort = (port) => port;
const promptAsLearning: (prompt: LoopToolGapPrompt) => LearningToolGapPrompt = (prompt) => prompt;

test("settled successful calls carry version and hashes without leaking arguments or inventing quality", async () => {
  let observed: Parameters<LoopToolGapPort["observe"]>[0] | undefined;
  const port: LoopToolGapPort = { observe: async value => { observed = value; }, intentOn: () => true, requestPrompt: async () => undefined };

  await reportToolGapBeat({ port, turnId: "task", beat: 2, take: undefined, emit: () => {},
    tools: { snapshot: () => [{ name: "tool", versionId: "version-1", description: "Tool", sideEffect: "read_only", needsApproval: false,
      parameters: {}, timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } }], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    transcript: [{ kind: "tool_call", sequence: 1, name: "tool", toolCallId: "call", arguments: { secret: "private-input" } },
      { kind: "tool_result", sequence: 2, name: "tool", toolCallId: "call", outcome: "succeeded", output: "private-result", truncated: false }] });
  assert.equal(observed?.executions?.[0]?.execution, "returned");
  assert.equal(observed?.executions?.[0]?.versionId, "version-1");
  assert.match(observed?.executions?.[0]?.inputHash ?? "", /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(observed), /private-input|private-result|quality/);
});

test("J1 三个恒等赋值成立（不成立则本文件编译不过），围栏标记两份逐字相同", () => {
  assert.equal(LOOP_FENCE, LEARNING_FENCE);
  assert.equal(typeof portAsLearning, "function");
  assert.equal(typeof learningAsPort, "function");
  assert.equal(typeof promptAsLearning, "function");
});

test("J2 一个实现两侧口都装得上（装得上 = 方法名与签名都对得上）", async () => {
  const beats: number[] = [];
  const stub: LoopToolGapPort = {
    observe: async (report) => {
      beats.push(report.beat);
    },
    intentOn: () => true,
    requestPrompt: async () => ({ role: "system", content: "please self-report" }),
  };
  const asLearning: LearningToolGapPort = stub;

  assert.equal(asLearning.intentOn("turn-1", 1), true);
  const prompt = await asLearning.requestPrompt({ turnId: "turn-1", beat: 1, toolNames: [] });

  assert.equal(prompt?.role, "system");
  await asLearning.observe({ turnId: "turn-1", beat: 7, failures: [], toolNames: [] });
  assert.deepEqual(beats, [7]);
});

test("J3 自报是可选的：缺席表示「这一拍没有自报」，不是空串", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const port: LearningToolGapPort = {
    observe: async (report) => {
      seen.push({ ...report });
    },
    intentOn: () => false,
    requestPrompt: async () => undefined,
  };

  await port.observe({ turnId: "turn-1", beat: 1, failures: [], toolNames: [] });
  assert.equal("selfReport" in (seen[0] ?? {}), false);
});
