import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { emptyUsage, type ProviderEvent } from "../ports/provider.js";
import {
  DEFAULT_METHOD_GRANT,
  MAX_CARD_CHARS,
  cardLengthOf,
  type MethodCard,
  type MethodRelease,
} from "../learning/agent/subsystems/method/index.js";
import { admitCard, type GateContext } from "../learning/agent/subsystems/method/domain/gate.js";
import { emptyVocabulary } from "../learning/agent/subsystems/method/domain/vocabulary.js";
import {
  LEARNING_FENCE,
  MAX_HELD_CHARS,
  createMethodChannel,
  dispositionOf,
} from "./method-channel.js";
import { providerEventToInput } from "./provider-input.js";
import { applyTextBlock, createStreamAccumulator } from "./stream-blocks.js";

/**
 * 附加通道的两条硬规则：剥得干净，以及**剥不干净时一个字符都不吞**。
 *
 * 这一组全部是纯函数用例，因为通道的设计就是把「怎么切」与「怎么发」分开：切
 * 由 `dispositionOf`（无状态、可被任意摆布）负责，发由 `createMethodChannel`
 * （按 `blockId` 记账的流式状态机）负责。分开之后，「半个围栏」这种最难的输入
 * 不需要一个假 provider 就能测。
 */

const FENCE = "```";
const MARKER = `${FENCE}${LEARNING_FENCE}`;

function fenced(json: string): string {
  return `${MARKER}\n${json}\n${FENCE}`;
}

const CARD = '{"hint":"keep paths inside the root","labels":["containment"]}';

function deltasAfter(events: ReadonlyArray<ProviderEvent>): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
}

function feed(channel: ReturnType<typeof createMethodChannel>, chunks: ReadonlyArray<string>): string {
  const seen: string[] = [];
  for (const chunk of chunks) {
    seen.push(deltasAfter(channel.rewrite({ type: "text_delta", blockId: "b1", text: chunk })));
  }
  return seen.join("");
}

test("a normal answer is forwarded whole and holds nothing back", () => {
  const text = "I wrote the file. Nothing to report.";
  const disposition = dispositionOf(text);
  assert.equal(disposition.visible, text);
  assert.equal(disposition.proposal, undefined);
  assert.equal(disposition.code, undefined);
});

test("a closed, parseable fence is stripped out of the visible text", () => {
  const text = `I wrote the file.\n\n${fenced(CARD)}`;
  const disposition = dispositionOf(text);
  assert.equal(disposition.visible.trim(), "I wrote the file.");
  assert.equal(disposition.proposal, CARD);
  assert.equal(disposition.code, undefined);
});

test("a fence the model opened and never closed is shown, not swallowed", () => {
  const text = `I wrote the file.\n\n${MARKER}\n{"hint":"half a th`;
  const disposition = dispositionOf(text);
  // fail-visible：扣住的那一段原样外发，只多一个码。用户看到的就是那半句。
  assert.equal(disposition.visible, text);
  assert.equal(disposition.code, "fence_unterminated");
  assert.equal(disposition.proposal, undefined);
});

test("a fence holding something that is not JSON is shown, not swallowed", () => {
  const text = `${MARKER}\nnot json at all\n${FENCE}`;
  const disposition = dispositionOf(text);
  assert.equal(disposition.visible, text);
  assert.equal(disposition.code, "proposal_not_json");
});

test("a fence longer than the hold cap is shown, not buffered forever", () => {
  const text = `${MARKER}\n${"x".repeat(MAX_HELD_CHARS + 1)}\n${FENCE}`;
  const disposition = dispositionOf(text);
  assert.equal(disposition.visible, text);
  assert.equal(disposition.code, "held_over_cap");
});

test("the hold cap is at least one full card, so a legal card can never hit it", () => {
  // 两个数字的关系必须由断言钉住：否则有一天把 900 调大、1200 忘了动，
  // 症状会是「偶尔吞掉一张合法卡」，而那种缺陷在别处看不出来。
  assert.equal(MAX_HELD_CHARS >= MAX_CARD_CHARS, true);
});

test("only the first parseable fence becomes the proposal: 共枪一枪一张卡", () => {
  const text = `${fenced(CARD)}\nand\n${fenced('{"hint":"second","labels":["containment"]}')}`;
  const disposition = dispositionOf(text);
  assert.equal(disposition.proposal, CARD);
  assert.equal(disposition.visible.trim(), "and");
});

test("the streaming channel emits exactly the visible text, in order, with no gaps", () => {
  const channel = createMethodChannel();
  const events: ProviderEvent[] = [
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text: "working.\n" },
    { type: "text_delta", blockId: "b1", text: fenced(CARD) },
    { type: "text_end", blockId: "b1" },
  ];
  const visible = events.map((event) => deltasAfter(channel.rewrite(event))).join("");

  assert.equal(visible, "working.\n");
  assert.equal(channel.take().proposal, CARD);
  assert.equal(channel.take().code, undefined);
});

test("a marker split across deltas is held, then stripped, and leaks nothing", () => {
  const channel = createMethodChannel();
  // 标记被从任意位置切开：` ` `` `` ` `` ` ```t ` 都可能是一拍的结尾。
  const visible = feed(channel, ["done.", "\n", "``", "`trylo", "-learning\n", CARD, "\n```"]);

  // 标记之前的部分照常外发，标记之后的半段一个字符都没漏出来。
  assert.equal(visible, "done.\n");
  // 流还没结束，所以扣住的东西还没定论：`take` 此刻不给答案。
  assert.equal(channel.take().proposal, undefined);
  // 围栏合法又闭合，所以 text_end 没有新东西要补——多一个字符都说明扣多了。
  assert.equal(deltasAfter(channel.rewrite({ type: "text_end", blockId: "b1" })), "");
  assert.equal(channel.take().proposal, CARD);
  assert.equal(channel.take().code, undefined);
});

test("a stream that ends mid-fence flushes the held text instead of dropping it", () => {
  const channel = createMethodChannel();
  const visible = feed(channel, ["done.", "\n", "``", "`trylo", "-learning\n", '{"hint":"half a th']);

  assert.equal(visible, "done.\n");
  const tail = deltasAfter(channel.rewrite({ type: "text_end", blockId: "b1" }));

  // 未闭合的围栏在 text_end 那一刻**原样**发出去：用户看到的就是那半句。
  assert.equal(tail, `${MARKER}\n{"hint":"half a th`);
  assert.equal(channel.take().code, "fence_unterminated");
  assert.equal(channel.take().proposal, undefined);
});

test("non-text events pass through the channel untouched, field for field", () => {
  const channel = createMethodChannel();
  const call: ProviderEvent = {
    type: "tool_call",
    toolCallId: "call-1",
    name: "write_file",
    arguments: { path: "a.txt" },
  };

  assert.deepEqual(channel.rewrite(call), [call]);
  const usage: ProviderEvent = { type: "usage", usage: emptyUsage("snapshot") };

  assert.deepEqual(channel.rewrite(usage), [usage]);
});

/**
 * 合同 T15：这一拍的两样输出（`§5.5`）。
 *
 * 围栏里其实有**两样**东西：给机器的那张卡（走门、进档案、对用户不可见）与给人
 * 的那一句 `summary`（拼回可见流、不过门、不入档）。把两样切开的是**通道**，门
 * 一行不动（`§2.2` 案 A），所以这一组用例量的是三个方向的边界：
 *
 *  - 摘掉 `summary` 之后，卡必须是**原来那张卡**（连字符帽都不该被它撑大）；
 *  - 摘 `summary` 只摘它自己（别的未知键仍然让卡过不了门，杠 2 不被削弱）；
 *  - 坏 `summary`（缺席 / 空串 / 不是字符串）**永远不拒卡**，用户只是看不到
 *    轻提示。
 *
 * 夹具是**文件**（`testdata/method-learning/channel/**`），与 `gate.test.ts` 同一
 * 口径：一段在代码里拼出来的围栏证明不了模型会怎么写。每个夹具的内容是一整段
 * 模型回答（散文 + 围栏），因为通道吃的是**整段文本**，不是围栏体。
 */

const CHANNEL_FIXTURES = path.join(process.cwd(), "testdata", "method-learning", "channel");

/** 夹具里那句话，逐字抄在这里，是为了断言失败时能直接看出差在哪个字符上。 */
const FIXTURE_SUMMARY = "这一轮我先把根目录确认了一遍，再把文件写进去。";

function channelFixture(name: string): Promise<string> {
  return readFile(path.join(CHANNEL_FIXTURES, name), "utf8");
}

/**
 * 门的上下文。
 *
 * 词表用**种子**（失败族闭集），所以夹具里的 `containment` 是已知词；工具目录里
 * 有卡点名的 `write_file`，所以第七条杠（幻觉工具）不会误伤。
 */
function gateContext(): GateContext {
  const release: MethodRelease = {
    releaseId: "rel-1",
    turnId: "turn-1",
    beat: 2,
    reason: "containment",
    tool: "write_file",
    code: "path_outside_workspace",
    fingerprint: "0123456789abcdef",
    repeats: 2,
    model: "default",
    slotChars: DEFAULT_METHOD_GRANT.slotChars,
    slotCards: DEFAULT_METHOD_GRANT.slotCards,
  };
  return { vocabulary: emptyVocabulary(), toolNames: ["write_file", "echo"], release };
}

/**
 * 原文减去那一整段围栏。
 *
 * 围栏**之外**的文本照旧外发（剥离器只剥它正面认出来的那一块），所以这正是剥离
 * 之后**应该**剩下的可见文本——包括围栏收尾后面那个换行。
 */
function outsideFences(text: string): string {
  return text.slice(0, text.indexOf(MARKER)) + text.slice(text.lastIndexOf(FENCE) + FENCE.length);
}

/** 过门并取卡；被拒就是这条用例自己坏了。 */
function admittedCard(text: string): MethodCard {
  const verdict = admitCard(text, gateContext());
  if (verdict.kind !== "admitted") {
    assert.fail(`the gate refused the card: ${verdict.code}`);
  }
  return verdict.card;
}

test("T15: a fence that carries a summary admits, and the card it admits is the bare card", async () => {
  const disposition = dispositionOf(await channelFixture("fence_with_summary.txt"));
  const proposal = disposition.proposal;

  assert.notEqual(proposal, undefined, "the fence must be stripped out of the visible text");

  // ① 开工缺陷的回归：按 `§5.1` / `§5.5` 写出来的围栏（带 summary）以前被判
  //    `card_shape_invalid`——因为**整段体**被当成卡交给了门。现在过得了门。
  const card = admittedCard(proposal ?? "");

  // ② 门拿到的是摘过的那一份：与不带 summary 的同一张卡**逐字节**相同，所以卡里
  //    没有它，字符帽也量不到它。
  const bare = dispositionOf(await channelFixture("fence_without_summary.txt"));

  assert.equal(proposal, bare.proposal);
  assert.equal(cardLengthOf(card), cardLengthOf(admittedCard(bare.proposal ?? "")));

  // ③ 同一张卡配一句多长的 summary，卡都一样大：字符帽量的是卡，不是围栏。
  const noisy = `{"summary":"${"长".repeat(400)}",${(bare.proposal ?? "{}").slice(1)}`;
  const noisyDisposition = dispositionOf(fenced(noisy));

  assert.equal(noisyDisposition.summary?.length, 400);
  assert.equal(cardLengthOf(admittedCard(noisyDisposition.proposal ?? "")), cardLengthOf(card));

  // ④ 两样各归各位：卡上没有 summary 键，用户看到的那一句在 `summary` 上。
  assert.equal("summary" in card, false);
  assert.equal(disposition.summary, FIXTURE_SUMMARY);
  assert.equal(
    disposition.visible.trim(),
    "I checked the root before writing, so the file landed inside it.",
  );
});

test("T15: a summary that is absent, empty or not a string never costs the card", async () => {
  for (const name of [
    "fence_without_summary.txt",
    "fence_summary_empty.txt",
    "fence_summary_not_string.txt",
  ]) {
    const disposition = dispositionOf(await channelFixture(name));

    // 坏的 summary 只摘键、不产生那一句：卡照过，用户只是看不到轻提示。
    assert.equal(disposition.summary, undefined, name);
    assert.equal(
      admittedCard(disposition.proposal ?? "").hint,
      "keep the write inside the workspace root",
      name,
    );
  }
});

test("T15: stripping the summary takes the summary and nothing else", async () => {
  // 夹具里除了 summary 还多一个 `junk`：摘完仍然多一个字段，所以门照旧拒。这条钉
  // 住的是「案 A 不是给杠 2 开口子」——摘掉一个键不等于宽容整张卡。
  const disposition = dispositionOf(await channelFixture("fence_with_junk_key.txt"));

  assert.equal(disposition.summary, FIXTURE_SUMMARY);
  assert.deepEqual(admitCard(disposition.proposal ?? "", gateContext()), {
    kind: "refused",
    code: "card_shape_invalid",
  });
});

test("T15: the summary is appended to this block, so both downstream paths see it", async () => {
  const text = await channelFixture("fence_with_summary.txt");
  const channel = createMethodChannel();
  const acc = createStreamAccumulator(0);
  const journal: string[] = [];
  let allocated = 0;
  // 与 `stream.ts::consumeProviderStream` 同一口径：每个外发事件同时喂两条下游。
  const push = (event: ProviderEvent): void => {
    for (const one of channel.rewrite(event)) {
      if (one.type === "text_start" || one.type === "text_delta" || one.type === "text_end") {
        applyTextBlock(acc, one);
      }

      allocated += 1;
      const mapped = providerEventToInput(one, `evt-${allocated}`);
      if (mapped !== undefined && mapped.type === "text_delta") {
        journal.push(mapped.text);
      }
    }
  };

  const fenceAt = text.indexOf(MARKER);

  push({ type: "text_start", blockId: "b1" });
  push({ type: "text_delta", blockId: "b1", text: text.slice(0, fenceAt) });
  push({ type: "text_delta", blockId: "b1", text: text.slice(fenceAt) });
  push({ type: "text_end", blockId: "b1" });

  // 两条下游：`assistant_text` 转录项（下一拍的请求来源）与 journal 文本（用户终端）。
  const transcript = acc.transcriptItems
    .map((item) => (item.kind === "assistant_text" ? item.text : ""))
    .join("");
  const expected = `${outsideFences(text)}${FIXTURE_SUMMARY}`;

  assert.equal(transcript, expected);
  assert.equal(journal.join(""), expected);

  // 而卡在哪一条上都没有留下痕迹：连那句围栏标记都没漏出去。
  for (const seen of [transcript, journal.join("")]) {
    assert.equal(seen.includes("hint"), false);
    assert.equal(seen.includes(LEARNING_FENCE), false);
  }

  assert.equal(channel.take().summary, FIXTURE_SUMMARY);
  assert.notEqual(channel.take().proposal, undefined);
});

test("T15: when the visible text does not end in a newline, the summary gets its own line", () => {
  const summary = "我把根目录先确认了一遍。";
  const body =
    `{"summary":"${summary}","hint":"keep the write inside the workspace root",` +
    '"labels":["containment"]}';
  const channel = createMethodChannel();
  const streamed = deltasAfter(
    channel.rewrite({ type: "text_delta", blockId: "b1", text: `done.${fenced(body)}` }),
  );
  const appended = deltasAfter(channel.rewrite({ type: "text_end", blockId: "b1" }));

  assert.equal(streamed, "done.");
  assert.equal(appended, `\n${summary}`);
});
