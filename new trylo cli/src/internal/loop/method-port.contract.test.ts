import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  LEARNING_FENCE as LOOP_PORT_FENCE,
  type MethodBeatObservation,
  type MethodFeedbackItem as LoopFeedbackItem,
  type MethodFeedbackNotice as LoopFeedbackNotice,
  type MethodFieldingNotice as LoopFieldingNotice,
  type MethodLearningPort,
  type MethodSlotDelivery as LoopSlotDelivery,
  type MethodSlotReceipt as LoopSlotReceipt,
  type ObservedFailureFact,
} from "./method-port.js";
import { LEARNING_FENCE as CHANNEL_FENCE, MAX_HELD_CHARS } from "./method-channel.js";
import { FEEDBACK_FENCE as CHANNEL_FEEDBACK_FENCE } from "./method-feedback-channel.js";
import {
  MAX_CARD_CHARS,
  MAX_HINT_CHARS,
  isMethodPointer,
  type MethodCard,
} from "../learning/agent/subsystems/method/index.js";
import { variantOf } from "../learning/agent/subsystems/method/assets/archive.js";
import {
  LEARNING_FENCE as LEARNING_SIDE_FENCE,
  METHOD_FEEDBACK_FENCE as LEARNING_SIDE_FEEDBACK_FENCE,
  type MethodBeatReport,
  type MethodFeedbackItem,
  type MethodFeedbackNotice,
  type MethodFieldingNotice,
  type MethodLearningService,
  type MethodSlotDelivery,
  type MethodSlotReceipt,
} from "../learning/agent/subsystems/method/index.js";
import type { ObservedFact } from "../learning/agent/subsystems/method/index.js";
import { resolveProfile } from "../learning/profile/resolver.js";
import { emptyBoardState, type BoardState } from "../learning/control/state.js";

/**
 * 执行侧与学习侧两份声明的合同。
 *
 * `loop` 是冻结核心，不得 import `learning/**`（`loop/boundary.test.ts` 会把任何
 * 一条这样的 import 判红，而那道门只看**生产**文件），所以两边的声明只能各写一
 * 份。这个文件存在的全部意义就是让「声明打架」变成一次**编译错误**：下面几个恒
 * 等赋值若有一处不成立，`tsc` 就会红，而不是等到某天运行时才发现执行侧上报的字
 * 段学习侧根本没读。
 *
 * 同样地，`LEARNING_FENCE` 在三处各有一份字面量。写得不一致的症状是「模型按学习
 * 侧教的方式写围栏，执行侧一个也认不出来」——一张卡永远抽不出来，而且没有任何一
 * 条别的用例会红。
 */

// 两侧端口互相可赋值：字段名、字段类型、方法签名全部必须一致。
const portAsService: (port: MethodLearningPort) => MethodLearningService = (port) => port;
const serviceAsPort: (service: MethodLearningService) => MethodLearningPort = (service) => service;

// 一拍事实与一条失败事实也互相可赋值：执行侧报的东西学习侧必须一字不差地收下。
const reportAsLearning: (report: MethodBeatObservation) => MethodBeatReport = (report) => report;
const reportAsLoop: (report: MethodBeatReport) => MethodBeatObservation = (report) => report;
const factAsLearning: (fact: ObservedFailureFact) => ObservedFact = (fact) => fact;
const factAsLoop: (fact: ObservedFact) => ObservedFailureFact = (fact) => fact;

// ME0-1：receipt 与交付物也必须两份声明互相可赋值。少了这几条，「学习侧多了一个
// 字段而执行侧没跟上」会一路编译通过、直到运行时才在归因那一刻暴露。
const receiptAsLearning: (receipt: LoopSlotReceipt) => MethodSlotReceipt = (receipt) => receipt;
const receiptAsLoop: (receipt: MethodSlotReceipt) => LoopSlotReceipt = (receipt) => receipt;
const deliveryAsLearning: (delivery: LoopSlotDelivery) => MethodSlotDelivery = (delivery) => delivery;
const deliveryAsLoop: (delivery: MethodSlotDelivery) => LoopSlotDelivery = (delivery) => delivery;

// ME0-2：真实发送的通知也必须两份声明互相可赋值。它刻意没有 `observedAt`——执行
// 环不读时钟——所以两侧字段集必须逐字相同，否则「学习侧多要一个执行侧给不出的时
// 刻」会一路编译通过，直到上场那一刻才在运行时暴露。
const fieldingAsLearning: (notice: LoopFieldingNotice) => MethodFieldingNotice = (notice) => notice;
const fieldingAsLoop: (notice: MethodFieldingNotice) => LoopFieldingNotice = (notice) => notice;

// ME0-3：帮助自报的 item 与通知也必须两份声明互相可赋值。item 携带 versionId 而不
// 是 ref（ref 的语义到执行侧为止），通知同样刻意没有 `observedAt`——执行环不读时钟。
// 少了这几条，「学习侧把 helped 读成 optional 而执行侧当成必填」会一路编译通过，直到
// 归因那一刻才在运行时暴露。
const feedbackItemAsLearning: (item: LoopFeedbackItem) => MethodFeedbackItem = (item) => item;
const feedbackItemAsLoop: (item: MethodFeedbackItem) => LoopFeedbackItem = (item) => item;
const feedbackAsLearning: (notice: LoopFeedbackNotice) => MethodFeedbackNotice = (notice) => notice;
const feedbackAsLoop: (notice: MethodFeedbackNotice) => LoopFeedbackNotice = (notice) => notice;

test("the two port declarations still describe each other", () => {
  const bridges = [
    portAsService,
    serviceAsPort,
    reportAsLearning,
    reportAsLoop,
    receiptAsLearning,
    receiptAsLoop,
    deliveryAsLearning,
    deliveryAsLoop,
    fieldingAsLearning,
    fieldingAsLoop,
    feedbackItemAsLearning,
    feedbackItemAsLoop,
    feedbackAsLearning,
    feedbackAsLoop,
  ];

  for (const bridge of bridges) {
    assert.equal(typeof bridge, "function");
  }

  // 交付物的两项各自独立：`message` 是给 provider 的，`receipts` 是执行侧的
  // 事实。合同测试把「两边的字段名与类型一字不差」变成一次编译错误。
  assert.deepEqual(Object.keys(receiptAsLoop({ ref: "m1", versionId: "v", proposalId: "p", nicheId: "n" })).sort(), [
    "nicheId",
    "proposalId",
    "ref",
    "versionId",
  ]);
  // 通知没有 `observedAt`：四项，且四项就是全部——多一个字段这里就红。
  assert.deepEqual(
    Object.keys(
      fieldingAsLoop({
        attemptId: "att",
        turnId: "trn",
        beat: 1,
        receipts: [{ ref: "m1", versionId: "v", proposalId: "p", nicheId: "n" }],
      }),
    ).sort(),
    ["attemptId", "beat", "receipts", "turnId"],
  );
  // 反馈通知同样没有 `observedAt`：四项，且四项就是全部。item 只有 versionId 与
  // helped 两项——ref 不在通知里，它在执行侧就被解析成了 versionId。
  assert.deepEqual(
    Object.keys(
      feedbackAsLoop({
        attemptId: "att",
        turnId: "trn",
        beat: 1,
        items: [{ versionId: "v", helped: true }],
      }),
    ).sort(),
    ["attemptId", "beat", "items", "turnId"],
  );
  assert.deepEqual(Object.keys(feedbackItemAsLoop({ versionId: "v", helped: false })).sort(), [
    "helped",
    "versionId",
  ]);
  assert.deepEqual(Object.keys(factAsLearning({ tool: "t", code: "c", fingerprint: "f" })).sort(), [
    "code",
    "fingerprint",
    "tool",
  ]);
  assert.deepEqual(Object.keys(factAsLoop({ tool: "t", code: "c", fingerprint: "f" })).sort(), [
    "code",
    "fingerprint",
    "tool",
  ]);
});

test("the fence marker is the same word on both sides of the boundary", () => {
  assert.equal(CHANNEL_FENCE, LEARNING_SIDE_FENCE);
  assert.equal(LOOP_PORT_FENCE, LEARNING_SIDE_FENCE);
});

test("the feedback fence is the same word on both sides, and distinct from the teaching fence", () => {
  // 反馈围栏写在 `learning/method/port.ts`（给模型看）、剥在
  // `loop/method-feedback-channel.ts`（从回答里切出来），两层不得互 import，所以
  // 两边各一份字面量、由这里钉住相等。写得不一致的症状与教学围栏一样：模型按学习
  // 侧教的方式写反馈块，执行侧一个也认不出来，于是反馈永远 unknown——而且没有别的
  // 用例会红。
  assert.equal(CHANNEL_FEEDBACK_FENCE, LEARNING_SIDE_FEEDBACK_FENCE);
  // 两个围栏必须是**不同**的词：一个收卡，一个收对已展示卡的帮助自报。若哪天它们
  // 被写成同一个词，两台剥离器就会争同一段文本。
  assert.notEqual(CHANNEL_FEEDBACK_FENCE, CHANNEL_FENCE);
});

test("the only pointer a method archive can name is shadow", () => {
  assert.equal(isMethodPointer("shadow"), true);
  // I2 的类型级表达：`"active"` 在 `MethodPointer` 里不可表达，所以这不是一条
  // 要记得遵守的纪律，而是一个连写都写不出来的值。
  assert.equal(isMethodPointer("active"), false);
});

test("no source file in this package names an active pointer for a method card", async () => {
  const roots = [
    path.join(process.cwd(), "src", "internal", "learning", "agent", "subsystems", "method"),
    ...["learning/method", "integration/method"]
      .map((dir) => path.join(process.cwd(), "src", "internal", dir))
      .filter((dir) => existsSync(dir)),
  ];
  const offenders: string[] = [];
  const pending = [...roots];

  while (pending.length > 0) {
    const root = pending.pop();
    if (root === undefined) break;

    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);

      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;

      // 只禁出现在**值位置**的 active：文档里解释「这个值不可表达」是必须写的，
      // 而一个真的把指针写成 active 的字面量不是。
      const source = await readFile(file, "utf8");
      if (/pointer\s*:\s*["']active["']/.test(source) || /["']active["']\s+as\s+MethodPointer/.test(source)) {
        offenders.push(file);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test("a method card cannot reach the user-facing profile", () => {
  // `resolveProfile` 只认 `pointer === "active"` 的激活，而本包一条激活都不发。
  // 就算硬塞一条 shadow 激活进去（模拟别的写入者），解析结果里也不会多出那条
  // 规则——所以「方法卡不上场到 user-facing profile」是结构事实（I2）。
  const card: MethodCard = {
    schemaVersion: 1,
    hint: "keep paths inside the root",
    appliesWhen: { tools: ["write_file"] },
    labels: ["containment"],
    lineage: { createdFrom: { turnId: "turn-1", beat: 2, reason: "containment" } },
  };
  const variant = variantOf({ versionId: "ver:1", proposalId: "prop:1", card, accounting: [] });
  const state: BoardState = {
    ...emptyBoardState(),
    assets: [
      {
        versionId: "ver:1",
        kind: "prompt_patch",
        schemaVersion: 1,
        content: card,
        contentHash: "hash",
        source: "inferred",
        scope: variant.nicheId,
        createdAt: "2026-09-16T00:00:00.000Z",
        createdFromProposalId: "prop:1",
      },
    ],
    activations: [
      {
        activationId: "act:1",
        scope: variant.nicheId,
        assetKind: "prompt_patch",
        pointer: "shadow",
        versionId: "ver:1",
        boardSequence: 1,
        generation: 1,
      },
    ],
  };
  const snapshot = resolveProfile(state, { scope: variant.nicheId });

  assert.deepEqual(snapshot.promptPatches, []);
  assert.deepEqual(snapshot.userRules, []);
});

test("the hold cap is wider than a card, and a hint is not the whole card", () => {
  assert.equal(MAX_HELD_CHARS > MAX_CARD_CHARS, true);
  assert.equal(MAX_HINT_CHARS < MAX_CARD_CHARS, true);
});
