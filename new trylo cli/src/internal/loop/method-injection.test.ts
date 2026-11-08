import assert from "node:assert/strict";
import test from "node:test";
import { methodMessage } from "../learning/agent/subsystems/method/index.js";
import { vocabularyOf } from "../learning/agent/subsystems/method/domain/vocabulary.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import { emptyUsage } from "../ports/provider.js";
import { decision, type PermissionPort } from "../ports/permission.js";
import type { ToolPort } from "../ports/tools.js";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
  type FakeProviderScript,
} from "./fakes.js";
import { MAX_HELD_CHARS } from "./method-channel.js";
import type {
  MethodBeatObservation,
  MethodFeedbackNotice,
  MethodFieldingNotice,
  MethodLearningPort,
  MethodSlotDelivery,
  MethodSlotRequest,
} from "./method-port.js";
import { runTurn, type LoopPorts, type RunTurnResult } from "./runner.js";

/**
 * 共枪附加通道在**执行环里**的样子（M2-1，合同 T1–T4 / T10 / I1）。
 *
 * 这里跑的是真的 `runTurn`，用假的 provider 与假的工具，把「学习开着」与「学习
 * 关着」两次跑放在一起比。所以下面几条断言都不是在测某个函数返回了什么，而是在
 * 测**一整条链**：`teachingFor` → `buildRequest` / `consumeProviderStream` →
 * `reportBeat` 的可见后果。
 *
 * 本文件在 `loop/**` 里 import `learning/**` 是**合法**的：`boundary.test.ts` 的
 * 方向门只看生产文件，测试文件不受它约束（`method-port.contract.test.ts` 同理）。
 * 用它换到的是「注入的那一段真的是学习侧写的那一段」——而不是这里自己手搓一个
 * 长得像的字符串，那样两边一起写错也全绿。
 */

const CARD_JSON =
  '{"hint":"keep the write inside the workspace root","family":"containment",' +
  '"labels":["containment"],"appliesWhen":{"tools":["echo"]}}';

const FENCE_OPEN = "```trylo-learning";
const FENCE_CLOSE = "```";

function fenced(body: string): string {
  return `${FENCE_OPEN}\n${body}\n${FENCE_CLOSE}`;
}

/** 一拍的正常回答：一段文本、一次 usage、一个收尾。 */
function textBeat(text: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text },
    { type: "text_end", blockId: "b1" },
    { type: "usage", usage: emptyUsage("snapshot") },
    { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
  ];
}

/**
 * 一拍发一个工具调用，然后要求再走一拍。
 *
 * `requiresFollowUp` 是必须的：工具结算完而 provider 没要求后续时，`decideIterationEnd`
 * 读作 `provider_error`（一拍里工具做完了、模型却没说下一步），turn 就停在拍一。
 * 真实 adapter 在 `finish_reason: "tool_calls"` 时正是这么置的。
 */
const TOOL_BEAT: ReadonlyArray<ProviderEvent> = [
  { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: { value: 1 } },
  { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
];

/** 两个拍的脚本，用来观察「跨拍」这件事（意图是拍 N+1 的，不是当拍的）。 */
function twoBeats(second: string): FakeProviderScript {
  return [TOOL_BEAT, textBeat(second)];
}

type Recording = {
  readonly port: ProviderPort;
  readonly requests: ProviderRequest[];
};

/** 把每一次请求都记下来，再交给真的假 provider 去产事件。 */
function recordingProvider(script: FakeProviderScript): Recording {
  const inner = createFakeProvider(script);
  const requests: ProviderRequest[] = [];
  const port: ProviderPort = {
    stream(request: ProviderRequest, signal: AbortSignal) {
      requests.push(request);
      return inner.stream(request, signal);
    },
  };

  return { port, requests };
}

type MethodSpec = {
  /** 哪几拍带学习意图（装剥离器）。 */
  readonly intentBeats?: ReadonlyArray<number>;
  /** 哪几拍要注入一条方法槽。 */
  readonly slotBeats?: ReadonlyArray<number>;
  readonly slot?: MethodSlotDelivery | undefined;
};

type ScriptedMethod = {
  readonly port: MethodLearningPort;
  readonly reports: MethodBeatObservation[];
  readonly slotRequests: MethodSlotRequest[];
  readonly fieldings: MethodFieldingNotice[];
  readonly feedbacks: MethodFeedbackNotice[];
  readonly endedTurns: string[];
  readonly toolsOffered: Array<ReadonlyArray<string>>;
};

/**
 * 一个完全受控的方法端口。
 *
 * 刻意**不是**真的板：这里要问的是执行环的纪律（什么时候注入、什么时候剥离、
 * 上报了什么），而板的取舍在 `learning/method` 与 `integration/method` 各自的
 * 用例里。把两件事分开，一条红就只说明一个地方坏了。
 */
function scriptedMethod(spec: MethodSpec = {}): ScriptedMethod {
  const reports: MethodBeatObservation[] = [];
  const slotRequests: MethodSlotRequest[] = [];
  const fieldings: MethodFieldingNotice[] = [];
  const feedbacks: MethodFeedbackNotice[] = [];
  const endedTurns: string[] = [];
  const toolsOffered: Array<ReadonlyArray<string>> = [];
  const intents = new Set(spec.intentBeats ?? []);
  const slots = new Set(spec.slotBeats ?? []);
  const port: MethodLearningPort = {
    async observe(report: MethodBeatObservation) {
      reports.push(report);
    },
    intentOn(_turnId: string, beat: number) {
      return intents.has(beat);
    },
    async requestSlot(request: MethodSlotRequest) {
      slotRequests.push(request);
      toolsOffered.push(request.toolNames);
      return slots.has(request.beat) ? spec.slot : undefined;
    },
    async recordFielding(notice: MethodFieldingNotice) {
      fieldings.push(notice);
    },
    async recordFeedback(notice: MethodFeedbackNotice) {
      feedbacks.push(notice);
    },
    async endTurn(turnId: string) {
      endedTurns.push(turnId);
    },
  };

  return { port, reports, slotRequests, fieldings, feedbacks, endedTurns, toolsOffered };
}

type RunOptions = {
  readonly script: FakeProviderScript;
  readonly method?: ScriptedMethod | undefined;
  readonly tools?: ToolPort | undefined;
  /** 覆盖脚本 provider：用来模拟「start 前抛错」「start 后中途取消」这类时序。 */
  readonly provider?: ProviderPort | undefined;
  /** 覆盖审批口：F14 要一个会记录「问了谁」并一律拒绝的口。 */
  readonly permission?: PermissionPort | undefined;
  readonly cancelSignal?: AbortSignal | undefined;
};

type RunOutcome = {
  readonly provider: Recording;
  readonly result: RunTurnResult;
};

async function run(options: RunOptions): Promise<RunOutcome> {
  const provider = recordingProvider(options.script);
  const ports: LoopPorts = {
    provider: options.provider ?? provider.port,
    // 不要求批准，也不注入 sandbox：本文件测的是学习通道，让工具那一侧尽量无
    // 摩擦（一次批准会多一条 permission 命令，让失败的位置变得难读）。
    tools: options.tools ?? createFakeTools([toolResult({ ok: true })], [echoBinding({ needsApproval: false })]),
    permission: options.permission ?? createFakePermission("approved"),
    profile: emptyProfileLoader(),
    ...(options.method === undefined ? {} : { method: options.method.port }),
  };
  const result = await runTurn(ports, {
    sessionId: "ses-m2",
    turnId: "trn-m2",
    correlationId: "cor-m2",
    text: "please do the thing",
    ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
  });

  return { provider, result };
}

/** 模型写出来的那部分（transcript 一路）。 */
function assistantTextOf(result: RunTurnResult): string {
  let text = "";

  for (const item of result.transcript) {
    if (item.kind === "assistant_text") {
      text += item.text;
    }
  }

  return text;
}

/** 用户终端看到的那部分（journal `text` 一路）。 */
function journalTextOf(result: RunTurnResult): string {
  let text = "";

  for (const envelope of result.envelopes) {
    if (envelope.kind !== "text") {
      continue;
    }
    const value = envelope.payload.text;
    text += typeof value === "string" ? value : "";
  }

  return text;
}

function observationsOf(result: RunTurnResult): ReadonlyArray<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];

  for (const envelope of result.envelopes) {
    if (envelope.kind === "observation") {
      found.push(envelope.payload as Record<string, unknown>);
    }
  }

  return found;
}

test("T1/I1: learning off is byte-identical to the un-wired path", async () => {
  const body = `before ${fenced(CARD_JSON)} after`;
  const script: FakeProviderScript = [textBeat(body)];
  const method = scriptedMethod();

  const off = await run({ script });
  const on = await run({ script, method });

  // 端口确实被问过——否则下面两条相等只是因为什么都没发生。
  assert.equal(method.slotRequests.length, 1);
  assert.equal(method.reports.length, 1);
  assert.equal(method.reports[0]?.proposal, undefined);

  // 请求逐字相同：没有多出来的 system，没有少掉的字符。
  assert.deepEqual(on.provider.requests, off.provider.requests);
  // 一整本 journal 也相同：注入与剥离都没有留下第二处痕迹。
  assert.deepEqual(on.result.envelopes, off.result.envelopes);
  // 「开着但这一拍什么都没编出来」不是「随手剥一段」：围栏原样可见。
  assert.equal(assistantTextOf(on.result), body);
  assert.equal(assistantTextOf(on.result), assistantTextOf(off.result));
  assert.equal(journalTextOf(on.result), body);
});

test("I1: an injected slot and a stripped fence are two separate decisions", async () => {
  const body = `before ${fenced(CARD_JSON)} after`;
  const method = scriptedMethod({ intentBeats: [1] });
  const { provider, result } = await run({ script: [textBeat(body)], method });

  // 有意图 → 剥掉了围栏；没有槽 → 一条 system 都不加。
  assert.equal(assistantTextOf(result), "before  after");
  assert.equal(journalTextOf(result), "before  after");
  assert.equal(method.reports[0]?.proposal, CARD_JSON);

  for (const request of provider.requests) {
    for (const message of request.messages) {
      assert.equal(message.content.includes("[method slot]"), false);
    }
  }
});

test("a fence written on a beat that was not released is left alone", async () => {
  const body = `before ${fenced(CARD_JSON)} after`;
  // 意图记在拍二上，而围栏出现在拍一：拍域的判定必须挡住它。
  const method = scriptedMethod({ intentBeats: [2] });
  const { result } = await run({ script: [textBeat(body)], method });

  assert.equal(assistantTextOf(result), body);
  assert.equal(journalTextOf(result), body);
  assert.equal(method.reports[0]?.proposal, undefined);
});

test("T2: a released beat appends exactly one system message, both segments present", async () => {
  const vocabulary = vocabularyOf([]);
  const slot = methodMessage({
    fielded: [
      {
        receipt: { ref: "m1", versionId: "ver:1", proposalId: "prop:1", nicheId: "niche:1" },
        hint: "keep the write inside the workspace root",
      },
    ],
    intent: true,
    vocabulary,
  });

  assert.notEqual(slot, undefined, "the learning side must compile a slot for this input");

  if (slot === undefined) {
    return;
  }

  const script = twoBeats("done");
  const method = scriptedMethod({ intentBeats: [2], slotBeats: [2], slot });
  const on = await run({ script, method });
  const off = await run({ script });

  const firstOn = on.provider.requests[0];
  const secondOn = on.provider.requests[1];
  const firstOff = off.provider.requests[0];
  const secondOff = off.provider.requests[1];

  assert.notEqual(firstOn, undefined);
  assert.notEqual(secondOn, undefined);
  assert.notEqual(firstOff, undefined);
  assert.notEqual(secondOff, undefined);

  if (firstOn === undefined || secondOn === undefined) {
    return;
  }

  if (firstOff === undefined || secondOff === undefined) {
    return;
  }

  // 拍一没有意图：连历史都逐字相同。
  assert.deepEqual(firstOn.messages, firstOff.messages);
  // 拍二多出来的**恰好一条**，且落在尾部。
  assert.equal(secondOn.messages.length, secondOff.messages.length + 1);
  // ME0：**只有 message 进请求**，receipts 留在执行侧。
  assert.deepEqual(secondOn.messages[secondOn.messages.length - 1], slot.message);

  // 两段都在：槽（经验）与意图（怎么交、能用什么词）。
  assert.equal(slot.message.content.includes("[method slot]"), true);
  assert.equal(slot.message.content.includes("- [m1] keep the write inside the workspace root"), true);
  assert.equal(slot.message.content.includes("[learning intent]"), true);
  assert.equal(slot.message.content.includes("trylo-learning"), true);
  assert.equal(slot.message.content.includes(vocabulary.known.join(", ")), true);
  assert.equal(slot.message.content.includes("addLabels"), true);

  // I3：学习意图不碰工具目录、也不碰别的请求字段。
  assert.deepEqual(secondOn.tools, firstOn.tools);
  assert.deepEqual(secondOn.tools, secondOff.tools);
  assert.equal(secondOn.model, secondOff.model);
  assert.equal(secondOn.attemptId, secondOff.attemptId);
});

test("T3: a legal fence is stripped from the transcript and from the journal", async () => {
  const body = `before ${fenced(CARD_JSON)} after`;
  const method = scriptedMethod({ intentBeats: [1] });
  const { result } = await run({ script: [textBeat(body)], method });

  const visible = "before  after";

  assert.equal(assistantTextOf(result), visible);
  assert.equal(journalTextOf(result), visible);
  // 两条路各自逐字不含卡文本——只堵住其中一条会留下一个静默的泄漏口。
  assert.equal(assistantTextOf(result).includes(CARD_JSON), false);
  assert.equal(journalTextOf(result).includes(CARD_JSON), false);
  // 剥下来的原文按严格 JSON 文本交给学习侧。
  assert.equal(method.reports[0]?.proposal, CARD_JSON);
  // 抽取本身不是降级。
  assert.deepEqual(observationsOf(result), []);
});

test("T4: an unusable fence stays visible, word for word, and is reported", async () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly text: string; readonly code: string }> = [
    {
      name: "unterminated",
      text: `before ${FENCE_OPEN}\n${CARD_JSON}`,
      code: "fence_unterminated",
    },
    {
      name: "not json",
      text: `before ${fenced("prose, not a card")}`,
      code: "proposal_not_json",
    },
    {
      name: "over cap",
      text: `before ${fenced("x".repeat(MAX_HELD_CHARS))}`,
      code: "held_over_cap",
    },
  ];

  for (const one of cases) {
    const method = scriptedMethod({ intentBeats: [1] });
    const { result } = await run({ script: [textBeat(one.text)], method });

    // fail-visible：剥不掉的整段原样外发，两条路都不许吞字。
    assert.equal(assistantTextOf(result), one.text, one.name);
    assert.equal(journalTextOf(result), one.text, one.name);
    assert.equal(method.reports[0]?.proposal, undefined, one.name);
    const degraded = observationsOf(result).filter(
      (payload) => payload.component === "method_channel",
    );

    assert.equal(degraded.length, 1, one.name);
    assert.equal(degraded[0]?.reason, one.code, one.name);
    assert.equal(degraded[0]?.degraded, true, one.name);
  }
});

test("T10: the method port adds no provider call", async () => {
  const script = twoBeats("done");
  const off = await run({ script });
  const on = await run({ script, method: scriptedMethod({ intentBeats: [1, 2] }) });

  assert.equal(off.provider.requests.length, 2);
  assert.equal(on.provider.requests.length, off.provider.requests.length);
});

test("the sensor reports this beat's tool catalog and this beat's proposal", async () => {
  const body = `before ${fenced(CARD_JSON)} after`;
  const method = scriptedMethod({ intentBeats: [1, 2] });
  const { result } = await run({ script: twoBeats(body), method });

  assert.equal(method.reports.length, 2);
  // 拍一：一个工具调用结算了（成功），没有失败，也没有围栏。
  const first = method.reports[0];

  assert.equal(first?.turnId, "trn-m2");
  assert.equal(first?.beat, 1);
  assert.deepEqual(first?.succeededTools, ["echo"]);
  assert.deepEqual(first?.failures, []);
  assert.equal(first?.toolNames.includes("echo"), true);
  assert.equal(first?.proposal, undefined);
  // 拍二：同一批事实，加上这一拍从附加通道抽出来的原文。
  const second = method.reports[1];

  assert.equal(second?.beat, 2);
  assert.equal(second?.proposal, CARD_JSON);
  // 拍域：第二拍不再重报第一拍已经结算的工具。
  assert.deepEqual(second?.succeededTools, []);
  assert.equal(assistantTextOf(result), "before  after");
});

test("the port is closed exactly once, with this turn's id", async () => {
  const method = scriptedMethod();
  await run({ script: [textBeat("hi")], method });
  assert.deepEqual(method.endedTurns, ["trn-m2"]);
});

test("the tool names the slot is compiled against are the real catalog", async () => {
  const method = scriptedMethod();

  await run({
    script: [textBeat("hi")],
    method,
    tools: createFakeTools([toolResult({ ok: true })], [echoBinding({ name: "read_file" })]),
  });
  assert.deepEqual(method.toolsOffered, [["read_file"]]);
});

/**
 * ME0-2：真实发送 → 落上场，在**执行环里**的样子。
 *
 * 这里跑真的 `runTurn`，用假 provider 与假方法端口，问的不是某个函数返回了什么，
 * 而是「`stream_start` 这件事有没有真的变成一条 `recordFielding`」。判定住在
 * `loop/method-attribution.ts`，触发点在 `runner.ts::runOneIteration`（流消费完、
 * 取消早退之前），所以这几条断言钉的是**接线**，不是单元。
 *
 * 与 `board.test.ts` 的分工：那边问「板带什么身份叫写口」，这边问「执行环什么
 * 时候、把哪一组 receipt 交给板」。一条红只说明一层坏了。
 */

const FIELD_SLOT: MethodSlotDelivery = {
  message: { role: "system", content: "[method slot]\n- [m1] keep the write inside the workspace root" },
  receipts: [{ ref: "m1", versionId: "ver:1", proposalId: "prop:1", nicheId: "niche:1" }],
};

const TWO_RECEIPT_SLOT: MethodSlotDelivery = {
  message: { role: "system", content: "[method slot]\n- [m1] a\n- [m2] b" },
  receipts: [
    { ref: "m1", versionId: "ver:1", proposalId: "prop:1", nicheId: "niche:1" },
    { ref: "m2", versionId: "ver:2", proposalId: "prop:2", nicheId: "niche:2" },
  ],
};

const STREAM_START: ProviderEvent = {
  type: "stream_start",
  providerId: "fake",
  model: "fake-model",
  warnings: [],
};

/** 一拍：真的发出去了（`stream_start`），然后正常收尾。 */
function startedTextBeat(text: string): ReadonlyArray<ProviderEvent> {
  return [STREAM_START, ...textBeat(text)];
}

/** start 前就出错：没有 `stream_start`，模型从没接受这个请求。 */
const BEFORE_START_ERROR: ReadonlyArray<ProviderEvent> = [
  { type: "error", class: "network", retryable: false, phase: "before_headers", message: "no route" },
];

/** start 后断线：发出去了，但任务失败。 */
const AFTER_START_ERROR: ReadonlyArray<ProviderEvent> = [
  STREAM_START,
  { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "cut" },
];

test("ME0-2/F01: a real send records one fielding carrying the slot's receipts", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });

  await run({ script: [startedTextBeat("done")], method });

  assert.equal(method.fieldings.length, 1);
  const notice = method.fieldings[0];

  assert.equal(notice?.turnId, "trn-m2");
  assert.equal(notice?.beat, 1);
  assert.deepEqual(notice?.receipts, FIELD_SLOT.receipts);
  // attemptId 是 exposureId 的身份根：非空字符串。
  assert.equal(typeof notice?.attemptId, "string");
  assert.equal((notice?.attemptId ?? "").length > 0, true);
});

test("ME0-2/F01: two receipts in one slot ride one fielding, in render order", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: TWO_RECEIPT_SLOT });

  await run({ script: [startedTextBeat("done")], method });

  assert.equal(method.fieldings.length, 1);
  assert.deepEqual(
    method.fieldings[0]?.receipts.map((receipt) => receipt.ref),
    ["m1", "m2"],
  );
});

test("ME0-2/F02: a failure before stream_start records no fielding", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const { result } = await run({ script: [BEFORE_START_ERROR], method });

  assert.equal(method.fieldings.length, 0);
  // 任务按原错误结束，不被学习记账改写。
  assert.equal(result.state.terminalReason, "failed");
});

test("ME0-2/F03: a failure after stream_start still fielded, and the turn still fails", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const { result } = await run({ script: [AFTER_START_ERROR], method });

  // 发出去了 = 上场成立，哪怕随后断线；feedback 留到 ME0-3，这里只问 fielding。
  assert.equal(method.fieldings.length, 1);
  // start 后的错误：字节已经出去了，delivered state 未知，所以适配器（adapt.ts）
  // 判 `transport_unknown` → 终态 "unknown"，而不是 start 前那种干净的 "failed"。
  // 两者都是非成功终态；这里钉住真实的 "unknown"，证明上场不被记账改写成假成功。
  assert.equal(result.state.terminalReason, "unknown");
});

test("ME0-2: a real send with an empty slot records no fielding", async () => {
  // slotBeats 不含 1 → requestSlot 回 undefined → 没有 receipt 被真正编进槽。
  const method = scriptedMethod();
  await run({ script: [startedTextBeat("done")], method });
  assert.equal(method.fieldings.length, 0);
});

test("ME0-2/F12: learning off records no fielding and adds no provider call", async () => {
  const on = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const started = await run({ script: [startedTextBeat("done")], method: on });
  const off = await run({ script: [startedTextBeat("done")] });

  assert.equal(on.fieldings.length, 1);
  // 关学习：没有端口，自然没有 fielding，且 provider 调用数与开着时逐拍相同。
  assert.equal(off.provider.requests.length, started.provider.requests.length);
});

test("ME0-2/F09: a cancel before stream_start records no fielding", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const abort = new AbortController();

  abort.abort(); // 进门就取消：第一道边界即停，stream 从没开始。
  const { result } = await run({ script: [startedTextBeat("done")], method, cancelSignal: abort.signal });

  assert.equal(method.fieldings.length, 0);
  assert.equal(result.state.terminalReason, "cancelled");
});

test("ME0-2/F09: a cancel after stream_start still records the fielding", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const abort = new AbortController();
  // 一个在 start 之后才把调用方取消拉起的 provider：recordFielding 挂在取消早退
  // **之前**，所以这一拍仍然落账，随后 turn 才以 cancelled 收尾。
  const provider: ProviderPort = {
    async *stream() {
      yield STREAM_START;
      abort.abort();
      yield { type: "cancel_ack" };
    },
  };
  const { result } = await run({ script: [], method, provider, cancelSignal: abort.signal });

  assert.equal(method.fieldings.length, 1);
  assert.equal(result.state.terminalReason, "cancelled");
});

/**
 * 轮询直到 `predicate` 为真或超时。挂起的流永不自己返回，所以「流还开着时账里
 * 有没有 fielding」只能这样在飞行中途观察——这正是 P1-1 要钉的时序。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("ME0-2/P1-1: fielding is committed at stream_start, while the stream is still open", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // start 之后挂起、直到测试放行才收尾的 provider：模拟「模型已接受请求、流还在
  // 长时间输出」。若 fielding 要等整段流消费完才落，这段挂起期内账上就一直是空的。
  const provider: ProviderPort = {
    async *stream() {
      yield STREAM_START;
      await gate;
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const running = run({ script: [], method, provider });

  try {
    // 流仍未结束（gate 未放行）时就已落账：这就是 P1-1 与「流结束后才记」的分水岭。
    const landed = await waitFor(() => method.fieldings.length === 1);
    assert.equal(landed, true, "fielding must be on the books before the stream finishes");
    assert.equal(method.fieldings.length, 1);
    assert.deepEqual(method.fieldings[0]?.receipts, FIELD_SLOT.receipts);
  } finally {
    release();
    await running;
  }
});

test("ME0-2/P1-1: a failure before stream_start commits no fielding even mid-stream", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // start 之前先挂起、放行后直接抛错：模型从没接受这个请求，上场不成立。整段挂起
  // 期内账上必须始终为 0——证明 P1-1 没有把「记上场」提前到 start 之前。
  const provider: ProviderPort = {
    async *stream() {
      await gate;
      throw new Error("before_headers");
    },
  };
  const running = run({ script: [], method, provider });

  try {
    const settledQuiet = await waitFor(() => false, 200);
    assert.equal(settledQuiet, false);
    assert.equal(method.fieldings.length, 0, "no stream_start means no fielding, mid-stream too");
  } finally {
    release();
    await running;
  }

  assert.equal(method.fieldings.length, 0);
});

/**
 * ME0-3：同一回答里的帮助自报 → 落账，在**执行环里**的样子。
 *
 * 与 ME0-2 同一套假 provider / 假方法端口，问的是「一段正常收尾的回答里那个
 * `trylo-method-feedback` 块，有没有变成一条 `recordFeedback`，且 ref 已被解析成
 * versionId」。判定住在 `loop/method-signal.ts::reportFeedback`（门：有端口 + 有
 * attempt + `sawFinish`），触发点在 `runner.ts::runOneIteration`（紧跟 recordFielding
 * 之后、取消早退之前），所以这几条钉的是**接线**，不是剥离器本身——剥离器的形状
 * 与错误码在 `method-feedback-channel.test.ts` 里逐条问过了。
 *
 * 与 `board.test.ts` 的分工同 ME0-2：那边问「板怎么把反馈归因到一次上场」，这边问
 * 「执行环什么时候、把哪一组已解析的 item 交给板」。
 */

const FEEDBACK_FENCE = "trylo-method-feedback";

function feedbackFenced(json: string): string {
  return `\`\`\`${FEEDBACK_FENCE}\n${json}\n\`\`\``;
}

test("ME0-3/F04: a completed answer's valid feedback is recorded with resolved versionIds", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: TWO_RECEIPT_SLOT });
  const answer = `All done.\n\n${feedbackFenced(
    '{"items":[{"ref":"m1","helped":true},{"ref":"m2","helped":false}]}',
  )}`;
  const { result } = await run({ script: [startedTextBeat(answer)], method });

  // 上场仍然落（ME0-2），反馈在它之后落（ME0-3），且两者同一次 attempt——这正是
  // 板侧归因要把反馈对回那一次真实展示所依赖的同源身份。
  assert.equal(method.fieldings.length, 1);
  assert.equal(method.feedbacks.length, 1);
  const notice = method.feedbacks[0];

  assert.equal(notice?.turnId, "trn-m2");
  assert.equal(notice?.beat, 1);
  assert.equal(notice?.attemptId, method.fieldings[0]?.attemptId);
  // ref 已在执行侧解析成 versionId；helped 逐条如实，false 不被丢掉（F04）。
  assert.deepEqual(notice?.items, [
    { versionId: "ver:1", helped: true },
    { versionId: "ver:2", helped: false },
  ]);
  // 围栏从两条可见路上都剥掉了，正文原样。
  assert.equal(assistantTextOf(result).includes(FEEDBACK_FENCE), false);
  assert.equal(journalTextOf(result).includes(FEEDBACK_FENCE), false);
  assert.equal(assistantTextOf(result).trim(), "All done.");
  // 抽取本身不是降级。
  assert.deepEqual(observationsOf(result), []);
});

test("ME0-3/F05: a response cut after stream_start fielded but records no feedback", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  // 发出去了、也写了合法反馈块，但流以错误收尾而非 finish：`sawFinish` 为假。
  const cut: ReadonlyArray<ProviderEvent> = [
    STREAM_START,
    { type: "text_start", blockId: "b1" },
    {
      type: "text_delta",
      blockId: "b1",
      text: feedbackFenced('{"items":[{"ref":"m1","helped":true}]}'),
    },
    { type: "text_end", blockId: "b1" },
    { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "cut" },
  ];
  const { result } = await run({ script: [cut], method });

  // 上场成立（start 见过），但没完成的回答不构成可信自报：反馈保持 unknown，绝
  // 不被当成 false（F05）。
  assert.equal(method.fieldings.length, 1);
  assert.equal(method.feedbacks.length, 0);
  assert.equal(result.state.terminalReason, "unknown");
});

test("ME0-3/F05: a fielded card the model says nothing about records no feedback", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  await run({ script: [startedTextBeat("All done, no feedback block.")], method });

  // 模型沉默 ≠「这些卡都没用」：没有块就没有反馈，账上分得开「没说」与「说了没用」。
  assert.equal(method.fieldings.length, 1);
  assert.equal(method.feedbacks.length, 0);
});

test("ME0-3: an invalid feedback block stays visible, is reported, and records nothing", async () => {
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const answer = `Done.\n\n${feedbackFenced('{"items":[{"ref":"m9","helped":true}]}')}`;
  const { result } = await run({ script: [startedTextBeat(answer)], method });

  // 整块拒绝：不落账。
  assert.equal(method.feedbacks.length, 0);
  // fail-visible：认不出的那段原样外发，用户看到的就是模型写的那一段。
  assert.equal(journalTextOf(result).includes(FEEDBACK_FENCE), true);
  assert.equal(assistantTextOf(result).includes(FEEDBACK_FENCE), true);
  const degraded = observationsOf(result).filter(
    (payload) => payload.component === "method_feedback_channel",
  );

  assert.equal(degraded.length, 1);
  assert.equal(degraded[0]?.reason, "feedback_ref_unknown");
  assert.equal(degraded[0]?.degraded, true);
});

test("ME0-3/F12: with no fielded card a feedback fence is never stripped or recorded", async () => {
  // 没有槽 → 没有 receipt → 不装反馈剥离器。模型即便写了一个反馈块，也没有任何
  // 一张「本请求真正展示过的卡」能与之对应。
  const method = scriptedMethod();
  const answer = `Done.\n\n${feedbackFenced('{"items":[{"ref":"m1","helped":true}]}')}`;
  const { result } = await run({ script: [startedTextBeat(answer)], method });

  assert.equal(method.feedbacks.length, 0);
  // 没装剥离器，那段围栏就是普通正文：逐字可见，一个字符都不削（与关学习同形）。
  assert.equal(assistantTextOf(result).includes(FEEDBACK_FENCE), true);
  assert.equal(journalTextOf(result).includes(FEEDBACK_FENCE), true);
  assert.deepEqual(observationsOf(result), []);
});

test("ME0-3/F12: learning off records no feedback and adds no provider call", async () => {
  const answer = `Done.\n\n${feedbackFenced('{"items":[{"ref":"m1","helped":true}]}')}`;
  const on = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const started = await run({ script: [startedTextBeat(answer)], method: on });
  const off = await run({ script: [startedTextBeat(answer)] });

  assert.equal(on.feedbacks.length, 1);
  // 关学习：没有端口，自然没有反馈，且 provider 调用数与开着时逐拍相同。
  assert.equal(off.provider.requests.length, started.provider.requests.length);
});

/**
 * ME0-4/F14：学习输出不能放权。
 *
 * 一张卡上场（拍一的请求带着 method slot），同一拍里那个 `needsApproval` 的工具
 * 仍然**照旧被询问**，且一律拒绝照旧生效。开关学习两次跑，问的工具与可见结局逐字
 * 相同——注入的那一段 system 既没有把审批变成自动通过，也没有改工具表里那个
 * `needsApproval`（那一面由 T2 的目录逐字相等钉住）。这是「学习永远不能授予权限或
 * 发起审批」在执行环里的运行期证据，而不只是一句结构承诺。
 */
function recordingDeny(log: string[]): PermissionPort {
  return {
    async request(action) {
      log.push(action.name);
      return { ticketId: `tkt-${action.toolCallId}`, toolCallId: action.toolCallId };
    },
    async awaitDecision() {
      return decision("denied", "once");
    },
  };
}

test("ME0-4/F14: a fielded slot cannot widen permission — approval is still asked, a denial still denies", async () => {
  const script: FakeProviderScript = [TOOL_BEAT, startedTextBeat("done")];
  const approvalTools = (): ToolPort =>
    createFakeTools([toolResult({ ok: true })], [echoBinding({ needsApproval: true })]);

  const askedOn: string[] = [];
  const method = scriptedMethod({ slotBeats: [1], slot: FIELD_SLOT });
  const on = await run({ script, method, tools: approvalTools(), permission: recordingDeny(askedOn) });

  const askedOff: string[] = [];
  const off = await run({ script, tools: approvalTools(), permission: recordingDeny(askedOff) });

  // 槽确实注入了：学习在正常工作，不是为了「什么都没发生」而绿。
  assert.equal(
    on.provider.requests[0]?.messages.some(
      (message) => message.role === "system" && message.content.includes("[method slot]"),
    ),
    true,
    "the slot must actually be injected on the beat that asks for approval",
  );
  // 审批照旧被询问，且开关学习两次问的完全一样：学习输出没有放权、没有改审批。
  assert.deepEqual(askedOn, ["echo"], "a needsApproval tool must still ask even with a slot fielded");
  assert.deepEqual(askedOn, askedOff, "learning must not change which approvals are asked");
  // 拒绝照旧生效：被拒的工具没有产出成功结果，两次运行的终态一致。
  assert.equal(on.result.state.terminalReason, off.result.state.terminalReason);
});

