import assert from "node:assert/strict";
import test from "node:test";
import { variantOf } from "../assets/archive.js";
import { createMethodBoard, type MethodBoard } from "./board.js";
import { slotLineFor } from "./compile.js";
import type { MethodCard, VariantRecord } from "../domain/contracts.js";
import {
  METHOD_FEEDBACK_FENCE,
  type ArchiveLoadResult,
  type MethodArchivePort,
  type MethodSlotDelivery,
} from "../port.js";

/**
 * ME0-1：槽交付**保住了身份**。
 *
 * 这一版以前的 `requestSlot` 只回一段文本，于是执行侧无从知道「刚才那句话是
 * 哪一版的」——模型说得再准，也没有东西能把一句「有帮助」对回一个具体版本。这
 * 份用例盯的就是那一件事，且只盯它：
 *
 *  1. 渲染进提示词的每一条 hint，都有一条 receipt 与它同序、指向**那一版**；
 *  2. 只有 `message` 是给 provider 的，receipts 是执行侧的内部事实；
 *  3. 空槽仍然是 `undefined`——「关着」与「开着但没编出来」在字节上不可区分
 *     （I1），这一条不能因为多了 receipts 就松掉。
 *
 * 顺序不假设「哪张卡更强」：槽 A 取最贴的那一张，这件事在 `compile.test.ts` 里
 * 有自己的用例。这里只断言**两个数组互为对方的说明**——这正是 receipt 存在的
 * 全部理由。
 */

const TOOLS: ReadonlyArray<string> = ["echo"];

function cardOf(hint: string, appliesWhen: MethodCard["appliesWhen"] = {}): MethodCard {
  return {
    schemaVersion: 1,
    hint,
    appliesWhen,
    labels: ["containment"],
    lineage: { createdFrom: { turnId: "turn-1", beat: 2, reason: "containment" } },
  };
}

/** 只回答「档里有这些」的内存口；本用例不写档。 */
function archiveOf(variants: ReadonlyArray<VariantRecord>): MethodArchivePort {
  const loaded: ArchiveLoadResult = { ok: true, variants, shadowActivations: {} };
  return {
    async load() {
      return loaded;
    },
    async commitCard() {
      return { ok: true, events: 0, duplicate: true };
    },
    async recordAccount() {
      return { ok: true, events: 0, duplicate: true };
    },
    async recordUse() {
      return { ok: true, events: 0, duplicate: true };
    },
    async recordFeedback() {
      return { ok: true, events: 0, duplicate: true };
    },
  };
}

function boardWith(variants: ReadonlyArray<VariantRecord>): MethodBoard {
  return createMethodBoard({
    archive: archiveOf(variants),
    emit: () => undefined,
    now: () => "2026-09-23T00:00:00.000Z",
  });
}

function variantOfHint(versionId: string, hint: string, appliesWhen?: MethodCard["appliesWhen"]): VariantRecord {
  return variantOf({
    versionId,
    proposalId: `prop:${versionId}`,
    card: cardOf(hint, appliesWhen),
    accounting: [],
  });
}

test("F01: two cards produce two receipts, each naming the version that was rendered", async () => {
  const first = variantOfHint("ver:1", "keep the write inside the workspace root", { tools: ["echo"] });
  const second = variantOfHint("ver:2", "read the file before editing it");
  const board = boardWith([first, second]);

  const delivery = await board.requestSlot({ turnId: "trn-1", beat: 1, toolNames: TOOLS });

  assert.notEqual(delivery, undefined, "two eligible cards must compile a slot");

  if (delivery === undefined) {
    return;
  }

  assert.equal(delivery.receipts.length, 2, "one receipt per rendered hint");
  // 引用按槽内次序编号，从 m1 起。次序本身有含义（槽 A 是最贴的那一张）。
  assert.deepEqual(
    delivery.receipts.map((receipt) => receipt.ref),
    ["m1", "m2"],
  );

  const content = delivery.message.content;

  for (const receipt of delivery.receipts) {
    const source = [first, second].find((record) => record.versionId === receipt.versionId);

    assert.notEqual(source, undefined, `receipt ${receipt.ref} must name a version from the archive`);

    if (source === undefined) {
      continue;
    }

    // 这一条断言就是 receipt 的全部意义：**渲染出来的那一行说的是这一版**。
    assert.equal(
      content.includes(slotLineFor(receipt.ref, source.card.hint)),
      true,
      `the rendered line for ${receipt.ref} must carry ${receipt.versionId}'s own hint`,
    );
    // 档里的另外两项身份也要跟着走，否则记账时仍对不回 proposal / niche。
    assert.equal(receipt.proposalId, source.proposalId);
    assert.equal(receipt.nicheId, source.nicheId);
    assert.notEqual(receipt.versionId, "");
  }

  assert.notEqual(delivery.receipts[0]?.versionId, delivery.receipts[1]?.versionId, "refs must not alias");

  // 渲染行数 = receipt 条数：两条平行的东西互为对方的说明。
  const rendered = content.split("\n").filter((line) => line.startsWith("- ["));

  assert.equal(rendered.length, delivery.receipts.length);
});

test("ME0-1: the same request compiles the same refs — no clock, no random", async () => {
  const board = boardWith([variantOfHint("ver:1", "keep the write inside the workspace root")]);
  const once = await board.requestSlot({ turnId: "trn-1", beat: 3, toolNames: TOOLS });
  const twice = await board.requestSlot({ turnId: "trn-1", beat: 3, toolNames: TOOLS });
  assert.deepEqual(twice, once, "a request must not depend on how many times it was asked");
});

test("ME0-3: a fielded card tells the model how to answer back, naming the feedback fence", async () => {
  const board = boardWith([variantOfHint("ver:1", "keep the write inside the workspace root", { tools: ["echo"] })]);
  const delivery = await board.requestSlot({ turnId: "trn-1", beat: 1, toolNames: TOOLS });

  assert.notEqual(delivery, undefined);

  if (delivery === undefined) {
    return;
  }

  const content = delivery.message.content;

  // 反馈段只在真的有卡上场时渲染：它点名反馈围栏、给出闭集形状，并说清「缺失记为
  // unknown，绝不当成 false」。没有这一段，模型就不知道要回反馈，ME0-3 的账永远是空。
  assert.equal(content.includes(METHOD_FEEDBACK_FENCE), true);
  assert.equal(content.includes('"items"'), true);
  assert.equal(content.includes("unknown"), true);
  // 反馈围栏与教学围栏是两个不同的词：一段收对已展示卡的帮助自报，一段收新卡。
  assert.notEqual(METHOD_FEEDBACK_FENCE, "trylo-learning");
});

test("ME0-1: an empty slot is still undefined — no message and no receipts", async () => {
  const board = boardWith([]);
  const delivery = await board.requestSlot({ turnId: "trn-1", beat: 1, toolNames: TOOLS });
  // 这条是 I1 的一半：多了 receipts 之后，「没编出来」仍然不是「编出空的一条」。
  assert.equal(delivery, undefined);
});

test("ME0-1: a bare message is not a delivery — the old contract is unrepresentable now", () => {
  // 编译期负例，不是运行期断言。ME0-1 以前 `requestSlot` 回的就是一条裸
  // `{role,content}`；下面这一行靠 `@ts-expect-error` 断言「它**不再**是交付物」。
  // 如果哪天有人把交付物改回裸消息，这个对象就成了合法赋值 ⇒ tsc 报 TS2578
  // （未使用的指令）⇒ 用例红。于是「发了文本但丢了身份」这件事连写都写不出来。
  // @ts-expect-error — a bare system message is not a MethodSlotDelivery
  const notADelivery: MethodSlotDelivery = { role: "system", content: "one sentence, no identity" };
  assert.equal("receipts" in (notADelivery as object), false);
});

test("ME0-1: a card whose tool is not offered is not rendered, so it earns no receipt", async () => {
  const board = boardWith([variantOfHint("ver:1", "use a tool that is not here", { tools: ["absent_tool"] })]);
  const delivery = await board.requestSlot({ turnId: "trn-1", beat: 1, toolNames: TOOLS });
  // 不上场 = 没有 receipt = 不可能为它记账。三者是同一件事的三面。
  assert.equal(delivery, undefined);
});
