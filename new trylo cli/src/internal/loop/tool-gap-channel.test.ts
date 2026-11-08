import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../ports/provider.js";
import { LEARNING_FENCE } from "./method-port.js";
import {
  MAX_TOOL_GAP_HELD_CHARS,
  TOOL_GAP_FENCE,
  createToolGapChannel,
  dispositionOfToolGap,
} from "./tool-gap-channel.js";

/**
 * 第二型围栏（` ```trylo-tool-gap ` ）的三条硬规则，逐字沿用第一型的教训：
 *
 *  - **剥得干净。** 抽出来的自报不进 transcript、不进 journal——它是一句给学习的
 *    话，不是给用户看的内容。
 *  - **剥不干净时一个字符都不吞。** 闭合不了、超帽、内容不是 JSON，一律把扣住的
 *    那一段**原样外发**，只报一个码。用户看到的就是模型说的话。
 *  - **零缓冲。** 文本里没有标记时一个字符都不扣，正常拍的延迟是 0。
 *
 * 它是**独立的一台**，不是第一型的参数化：两台的机器各写各的，公用只到「围栏
 * 长什么样」这一层理解。于是第一型改口径时不会顺手改到这一台。
 */

const FENCE = "```";
const MARKER = `${FENCE}${TOOL_GAP_FENCE}`;

const REPORT = '{"need":"新工具:能做PDF表格抽取"}';

function fenced(body: string): string {
  return `${MARKER}\n${body}\n${FENCE}`;
}

function emittedText(events: ReadonlyArray<ProviderEvent>): string {
  let out = "";

  for (const event of events) {
    if (event.type === "text_delta") {
      out += event.text;
    }
  }

  return out;
}

test("I1 零缓冲：文本里没有标记时一个字符都不扣", () => {
  assert.deepEqual(dispositionOfToolGap("plain answer, no fence here"), {
    visible: "plain answer, no fence here",
  });
});

test("I2 闭合并是 JSON → 抽出自报，可见流里不留围栏", () => {
  const disposition = dispositionOfToolGap(`prefix\n${fenced(REPORT)}\nsuffix`);

  // 闭合围栏**后面那个换行**仍留在可见文本里：剥离器只摘围栏块，不替模型排版。
  assert.equal(disposition.visible, "prefix\n\nsuffix");
  assert.equal(disposition.selfReport, REPORT);
  assert.equal(disposition.code, undefined);
  assert.equal(disposition.visible.includes(TOOL_GAP_FENCE), false);
  assert.equal(disposition.visible.includes(REPORT), false);
});

test("I3 反例：围栏不闭合 → 原样外发，只报一个码（不许吞字）", () => {
  const text = `half an answer\n${MARKER}\n${REPORT}`;
  const disposition = dispositionOfToolGap(text);
  assert.equal(disposition.visible, text);
  assert.equal(disposition.code, "fence_unterminated");
  assert.equal(disposition.selfReport, undefined);
});

test("I4 反例：围栏里的东西不是 JSON → 原样外发", () => {
  const text = `model wrote prose instead\n${fenced("I think we need a new tool")}`;
  const disposition = dispositionOfToolGap(text);
  assert.equal(disposition.visible, text);
  assert.equal(disposition.code, "self_report_not_json");
});

test("I5 反例：超过扣留上限 → 原样外发（那只说明它在写别的文档）", () => {
  const text = `x\n${MARKER}\n${"y".repeat(MAX_TOOL_GAP_HELD_CHARS + 100)}\n${FENCE}`;
  const disposition = dispositionOfToolGap(text);
  assert.equal(disposition.visible, text);
  assert.equal(disposition.code, "held_over_cap");
});

test("I6 非文本事件一个字段都不改（附加通道在 tool_call 之外）", () => {
  const channel = createToolGapChannel();
  const event: ProviderEvent = {
    type: "tool_call",
    toolCallId: "call-1",
    name: "read_file",
    arguments: { path: "a.txt" },
  };
  const out = channel.rewrite(event);

  assert.equal(out.length, 1);
  assert.equal(out[0], event, "非文本事件必须原样通过（同一个对象，不是副本）");
});

test("I7 流式：半个标记先扣住，闭合后一次吐出，围栏体不外泄", () => {
  const channel = createToolGapChannel();
  const events: ProviderEvent[] = [
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text: "hello ```tr" },
    { type: "text_delta", blockId: "b1", text: `ylo-tool-gap\n${REPORT}\n${FENCE}` },
    { type: "text_end", blockId: "b1" },
  ];
  const seen: string[] = [];

  for (const event of events) {
    for (const one of channel.rewrite(event)) {
      seen.push(emittedText([one]));
    }
  }

  assert.equal(seen.join(""), "hello ", "半截标记不许漏出去，围栏体一个字都不许漏");
  assert.equal(channel.take().selfReport, REPORT);
  assert.equal(channel.take().code, undefined);
});

test("I8 take() 是幂等的：重复读得同一个答案", () => {
  const channel = createToolGapChannel();
  channel.rewrite({ type: "text_start", blockId: "b1" });
  channel.rewrite({ type: "text_delta", blockId: "b1", text: fenced(REPORT) });
  channel.rewrite({ type: "text_end", blockId: "b1" });
  assert.deepEqual(channel.take(), channel.take());
});

test("I9 独立一台：第一型的围栏（trylo-learning）不归它剥", () => {
  const text = `卡在这里\n${FENCE}${LEARNING_FENCE}\n{"hint":"x"}\n${FENCE}\n后面`;
  const disposition = dispositionOfToolGap(text);
  assert.equal(disposition.visible, text, "别人的围栏必须原样留在可见流里");
  assert.equal(disposition.selfReport, undefined);
});

test("I10 两个围栏标记必须逐字不同（同字就等于两台机器抢同一段文本）", () => {
  assert.notEqual(TOOL_GAP_FENCE, LEARNING_FENCE);
  assert.equal(TOOL_GAP_FENCE.startsWith(LEARNING_FENCE), false, "一个标记不能是另一个的前缀");
});

test("I11 抽出来的自报是严格 JSON 文本，学习层可以直接 parse", () => {
  const channel = createToolGapChannel();

  channel.rewrite({ type: "text_start", blockId: "b1" });
  channel.rewrite({ type: "text_delta", blockId: "b1", text: fenced(REPORT) });
  channel.rewrite({ type: "text_end", blockId: "b1" });
  const raw = channel.take().selfReport;

  assert.equal(typeof raw, "string");

  if (raw === undefined) {
    return;
  }

  assert.deepEqual(JSON.parse(raw), { need: "新工具:能做PDF表格抽取" });
});

test("I12 没有标记时通道是恒等的（一拍的延迟因此是 0）", () => {
  const channel = createToolGapChannel();
  const first = channel.rewrite({ type: "text_start", blockId: "b1" });
  const second = channel.rewrite({ type: "text_delta", blockId: "b1", text: "hello" });
  assert.equal(emittedText(first) + emittedText(second), "hello");
  assert.deepEqual(channel.take(), {});
});
