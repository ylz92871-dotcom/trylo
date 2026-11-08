import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderEvent } from "../ports/provider.js";
import type { MethodSlotReceipt } from "./method-port.js";
import {
  FEEDBACK_FENCE,
  MAX_HELD_CHARS,
  createMethodFeedbackChannel,
  type MethodFeedbackChannel,
} from "./method-feedback-channel.js";

/**
 * 反馈剥离器的硬规则：认得出合法自报、把 ref 解析成 versionId，以及**认不出时
 * 一个字符都不吞**。
 *
 * 与 `method-channel.test.ts` 同口径，但这台机器没有独立的纯函数入口——它的解析
 * 与流式扣字是同一个状态机（`createMethodFeedbackChannel`），所以用例都通过
 * `rewrite` / `take` 这一对流式接口来问。这样问到的正是执行环真正会走的那条路。
 */

const FENCE = "```";
const MARKER = `${FENCE}${FEEDBACK_FENCE}`;

function fenced(json: string): string {
  return `${MARKER}\n${json}\n${FENCE}`;
}

function receipt(ref: string, versionId: string): MethodSlotReceipt {
  return { ref, versionId, proposalId: `prop-${ref}`, nicheId: `niche-${ref}` };
}

const ONE = [receipt("m1", "ver-1")];
const TWO = [receipt("m1", "ver-1"), receipt("m2", "ver-2")];

function deltasAfter(events: ReadonlyArray<ProviderEvent>): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
}

/** 把一段文本按给定的切分喂进一个 block，返回可见文本与剥离器本身。 */
function run(
  receipts: ReadonlyArray<MethodSlotReceipt>,
  chunks: ReadonlyArray<string>,
): { readonly visible: string; readonly channel: MethodFeedbackChannel } {
  const channel = createMethodFeedbackChannel(receipts);

  channel.rewrite({ type: "text_start", blockId: "b1" });
  const seen: string[] = [];

  for (const chunk of chunks) {
    seen.push(deltasAfter(channel.rewrite({ type: "text_delta", blockId: "b1", text: chunk })));
  }

  seen.push(deltasAfter(channel.rewrite({ type: "text_end", blockId: "b1" })));

  return { visible: seen.join(""), channel };
}

test("a normal answer with no fence is forwarded whole and yields nothing", () => {
  const text = "I wrote the file. Nothing to report.";
  const { visible, channel } = run(ONE, [text]);
  assert.equal(visible, text);
  assert.deepEqual(channel.take(), {});
});

test("a closed, valid feedback block is stripped and its refs resolved to versionIds", () => {
  const text = `Done.\n\n${fenced('{"items":[{"ref":"m1","helped":true}]}')}`;
  const { visible, channel } = run(ONE, [text]);
  assert.equal(visible.trim(), "Done.");
  assert.deepEqual(channel.take().items, [{ versionId: "ver-1", helped: true }]);
  assert.equal(channel.take().code, undefined);
});

test("every item is resolved independently, keeping order and per-item helped", () => {
  const text = fenced('{"items":[{"ref":"m1","helped":true},{"ref":"m2","helped":false}]}');
  const { channel } = run(TWO, [text]);
  assert.deepEqual(channel.take().items, [
    { versionId: "ver-1", helped: true },
    { versionId: "ver-2", helped: false },
  ]);
});

test("an empty items array is a valid block that carries no feedback", () => {
  const { visible, channel } = run(ONE, [fenced('{"items":[]}')]);
  assert.equal(visible, "");
  assert.deepEqual(channel.take().items, []);
  assert.equal(channel.take().code, undefined);
});

test("a ref that is not in this request is shown, not swallowed, and coded unknown", () => {
  const text = fenced('{"items":[{"ref":"m9","helped":true}]}');
  const { visible, channel } = run(ONE, [text]);
  assert.equal(visible, text);
  assert.equal(channel.take().code, "feedback_ref_unknown");
  assert.equal(channel.take().items, undefined);
});

test("a ref repeated in one block rejects the whole block as duplicate", () => {
  const text = fenced('{"items":[{"ref":"m1","helped":true},{"ref":"m1","helped":false}]}');
  const { visible, channel } = run(ONE, [text]);
  assert.equal(visible, text);
  assert.equal(channel.take().code, "feedback_ref_duplicate");
  assert.equal(channel.take().items, undefined);
});

test("one bad item rejects the entire block: no partial acceptance", () => {
  // m1 is legal, m9 is not. The whole block must stay visible and record nothing,
  // so "what the model said" and "what the ledger recorded" cannot diverge.
  const text = fenced('{"items":[{"ref":"m1","helped":true},{"ref":"m9","helped":true}]}');
  const { visible, channel } = run(TWO, [text]);

  assert.equal(visible, text);
  assert.equal(channel.take().items, undefined);
  assert.equal(channel.take().code, "feedback_ref_unknown");
});

test("a body that is not JSON is shown and coded", () => {
  const text = `${MARKER}\nnot json at all\n${FENCE}`;
  const { visible, channel } = run(ONE, [text]);
  assert.equal(visible, text);
  assert.equal(channel.take().code, "feedback_not_json");
});

test("a top level that is not a single-items object is a shape failure", () => {
  for (const body of [
    '{"items":[{"ref":"m1","helped":true}],"extra":1}',
    '[{"ref":"m1","helped":true}]',
    '{"ref":"m1","helped":true}',
    '{"items":{"ref":"m1"}}',
  ]) {
    const { channel } = run(ONE, [fenced(body)]);
    assert.equal(channel.take().code, "feedback_shape_invalid", body);
    assert.equal(channel.take().items, undefined, body);
  }
});

test("an item with a wrong field set or a non-boolean helped is a shape failure", () => {
  for (const body of [
    '{"items":[{"ref":"m1"}]}',
    '{"items":[{"helped":true}]}',
    '{"items":[{"ref":"m1","helped":"yes"}]}',
    '{"items":[{"ref":"m1","helped":true,"junk":1}]}',
  ]) {
    const { channel } = run(ONE, [fenced(body)]);
    assert.equal(channel.take().code, "feedback_shape_invalid", body);
  }
});

test("a fence opened and never closed is shown at text_end, not swallowed", () => {
  const text = `Done.\n\n${MARKER}\n{"items":[{"ref":"m1"`;
  const { visible, channel } = run(ONE, [text]);
  assert.equal(visible, text);
  assert.equal(channel.take().code, "fence_unterminated");
  assert.equal(channel.take().items, undefined);
});

test("a fence longer than the hold cap is shown, not buffered forever", () => {
  const text = `${MARKER}\n${"x".repeat(MAX_HELD_CHARS + 1)}\n${FENCE}`;
  const { visible, channel } = run(ONE, [text]);
  assert.equal(visible, text);
  assert.equal(channel.take().code, "held_over_cap");
});

test("a marker split across deltas is held, then stripped, and leaks nothing", () => {
  const body = '{"items":[{"ref":"m1","helped":true}]}';
  const { visible, channel } = run(ONE, ["done.", "\n", "``", "`trylo", "-method-feedback\n", body, "\n```"]);
  assert.equal(visible, "done.\n");
  assert.deepEqual(channel.take().items, [{ versionId: "ver-1", helped: true }]);
  assert.equal(channel.take().code, undefined);
});

test("mid-stream the take is undecided; only text_end settles it", () => {
  const channel = createMethodFeedbackChannel(ONE);

  channel.rewrite({ type: "text_start", blockId: "b1" });
  channel.rewrite({
    type: "text_delta",
    blockId: "b1",
    text: fenced('{"items":[{"ref":"m1","helped":true}]}'),
  });
  // The block is complete in the text but the stream has not ended: no verdict yet.
  assert.deepEqual(channel.take(), {});
  channel.rewrite({ type: "text_end", blockId: "b1" });
  assert.deepEqual(channel.take().items, [{ versionId: "ver-1", helped: true }]);
});

test("only the first valid block becomes the items: one answer, one verdict", () => {
  const text =
    fenced('{"items":[{"ref":"m1","helped":true}]}') +
    "\nand\n" +
    fenced('{"items":[{"ref":"m1","helped":false}]}');
  const { visible, channel } = run(ONE, [text]);

  assert.deepEqual(channel.take().items, [{ versionId: "ver-1", helped: true }]);
  assert.equal(visible.trim(), "and");
});

test("the first illegal block fixes the code even if a later block is valid", () => {
  const text =
    fenced('{"items":[{"ref":"m9","helped":true}]}') +
    "\nthen\n" +
    fenced('{"items":[{"ref":"m1","helped":true}]}');
  const { channel } = run(ONE, [text]);

  assert.equal(channel.take().code, "feedback_ref_unknown");
  assert.deepEqual(channel.take().items, [{ versionId: "ver-1", helped: true }]);
});

test("non-text events pass through untouched, field for field", () => {
  const channel = createMethodFeedbackChannel(ONE);
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

test("text is forwarded in order with no gaps when several deltas precede a fence", () => {
  const { visible } = run(ONE, ["Hello ", "world.", "\n", fenced('{"items":[]}')]);
  assert.equal(visible, "Hello world.\n");
});

test("P1-2: a legal block followed by a long ordinary tail is still stripped (single chunk)", () => {
  // The cap must measure the *fence segment*, not marker-to-end-of-text. A short
  // closed feedback block with a long answer after it is the normal shape of a real
  // reply, and it must not be re-judged as held_over_cap (which leaks the fence).
  const tail = "x".repeat(MAX_HELD_CHARS + 50);
  const text = `${fenced('{"items":[{"ref":"m1","helped":true}]}')}${tail}`;
  const { visible, channel } = run(ONE, [text]);

  assert.equal(visible, tail, "the closed fence is stripped; only the ordinary tail is visible");
  assert.deepEqual(channel.take().items, [{ versionId: "ver-1", helped: true }]);
  assert.equal(channel.take().code, undefined);
});

test("P1-2: a block stripped in an early delta stays stripped as later deltas grow the tail", () => {
  // Each text_delta must not re-walk the whole answer from scratch: once a fence is
  // closed and stripped, growing the ordinary tail past the cap cannot resurrect it
  // as illegal, corrupt the visible length, or drop the already-parsed items.
  const fence = fenced('{"items":[{"ref":"m1","helped":true}]}');
  const tailA = "y".repeat(300);
  const tailB = "z".repeat(350);
  const { visible, channel } = run(ONE, [fence, tailA, tailB]);

  assert.equal(visible, tailA + tailB, "the fence stays stripped; only the ordinary tail is visible");
  assert.deepEqual(channel.take().items, [{ versionId: "ver-1", helped: true }]);
  assert.equal(channel.take().code, undefined);
});
