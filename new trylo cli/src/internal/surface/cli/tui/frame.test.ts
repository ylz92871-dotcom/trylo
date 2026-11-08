import assert from "node:assert/strict";
import { test } from "node:test";
import { displayWidth, renderFrame, wrapLine } from "./frame.js";
import { emptyTuiState, type TuiFacts } from "./state.js";

/**
 * Contract #1: the frame is a pure function — same state and width in, same
 * text out, no terminal required. These cases pin determinism, the status
 * bar's presence, and the wrapping rules.
 *
 * A4 is here too: the frame is measured in terminal columns, not in UTF-16
 * code units. The old wrap counted units, so fifty Chinese characters at width
 * 80 became one fifty-unit "line" that the terminal then wrapped into two — the
 * frame the shell believed it had drawn was not the frame on screen. Pure ASCII
 * is pinned alongside the CJK cases because the fix must not move it: for
 * ASCII, a code unit and a column are the same thing.
 */

const FACTS: TuiFacts = {
  sessionId: "repl-1",
  providerId: "fixture",
  model: "default",
  contextTokenLimit: undefined,
  maxIterations: 8,
};

/** Content lines of a frame: everything before the blank line and the bar. */
function bodyOf(frame: string): ReadonlyArray<string> {
  const lines = frame.split("\n");
  return lines.slice(0, lines.length - 3);
}

/** The status bar: the second-to-last line, with its dimming stripped. */
function barOf(frame: string): string {
  const lines = frame.split("\n");
  return (lines.at(-2) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Whether `text` holds half of a surrogate pair — what a cut emoji looks like. */
function hasLoneSurrogate(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      at += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("the same state and width render the same frame", () => {
  const one = renderFrame(emptyTuiState(FACTS), 80);
  const two = renderFrame(emptyTuiState(FACTS), 80);
  assert.equal(one, two);
});

test("an empty frame is the status bar, dimmed, and nothing else", () => {
  const frame = renderFrame(emptyTuiState(FACTS), 80);
  const lines = frame.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "");
  assert.match(lines[1] ?? "", /^\x1b\[2mfixture\/default \| iter -\/8 \| idle\x1b\[0m$/);
});

test("content lines render above the bar and hard-wrap at the width", () => {
  let state = emptyTuiState(FACTS);

  state = { ...state, lines: [{ tone: "assistant", text: "abcdefghij".repeat(10) }] };
  const frame = renderFrame(state, 20);
  const body = frame.split("\n").slice(0, 5);

  assert.equal(body.length, 5);

  for (const line of body) {
    assert.equal((line ?? "").length, 20);
  }
});

test("multi-line text keeps its line breaks", () => {
  const state = { ...emptyTuiState(FACTS), lines: [{ tone: "assistant" as const, text: "a\nb" }] };
  const body = renderFrame(state, 80).split("\n");
  assert.equal(body[0], "a");
  assert.equal(body[1], "b");
});

test("a width below the readability floor clamps instead of slivering", () => {
  const frame = renderFrame(emptyTuiState(FACTS), 2);
  for (const line of frame.split("\n")) {
    assert.equal((line ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/…$/, "").length <= 10, true);
  }
});

/**
 * A narrow terminal drops whole fields instead of cutting one in half.
 *
 * The old bar was assembled left to right and then truncated, so the only
 * field a narrow terminal was guaranteed to keep was the session id, while the
 * iteration budget and the token count were amputated at the right-hand end —
 * and a cut session id ("a-very-long-session…") is the one field on the bar
 * nobody acts on. Truncation is still the fallback, below, for a single field
 * longer than the whole terminal.
 */
test("a status bar wider than the terminal drops the least useful field whole", () => {
  const narrow = renderFrame(
    emptyTuiState({ ...FACTS, sessionId: "a-very-long-session-id-string" }),
    30,
  );
  const bar = barOf(narrow);

  assert.equal(bar.length <= 30, true, `${bar.length} columns in a 30-column terminal`);
  assert.equal(bar.includes("session"), false, "the session id was kept and something else dropped");
  assert.match(bar, /fixture\/default/, "the current model survived");
  assert.match(bar, /idle/, "the phase survived");
});

test("a field longer than the whole terminal is still cut, with a marker", () => {
  const state = { ...emptyTuiState(FACTS), lastStatus: "output_tokens_exhausted" };
  const bar = barOf(renderFrame(state, 20));
  assert.match(bar, /…$/, `the bar was ${displayWidth(bar)} columns wide and uncut`);
});

test("A4: pure ASCII wrapping is exactly what it was", () => {
  const text = "abcdefghij".repeat(10);
  assert.deepEqual(wrapLine(text, 20), Array.from({ length: 5 }, () => "abcdefghij".repeat(2)));
  assert.equal(displayWidth(text), 100);
});

test("A4: fifty Chinese characters at width 80 are two lines, none wider than 80", () => {
  const state = { ...emptyTuiState(FACTS), lines: [{ tone: "assistant" as const, text: "中".repeat(50) }] };
  const body = bodyOf(renderFrame(state, 80));

  assert.equal(body.length, 2);

  for (const line of body) {
    assert.equal(displayWidth(line) <= 80, true, `${displayWidth(line)} columns on one line`);
  }

  assert.equal(body.map((line) => displayWidth(line)).reduce((a, b) => a + b, 0), 100);
});

test("A4: an emoji is never cut in half", () => {
  const state = { ...emptyTuiState(FACTS), lines: [{ tone: "assistant" as const, text: "😀".repeat(30) }] };
  const body = bodyOf(renderFrame(state, 21));

  assert.equal(body.length > 1, true);

  for (const line of body) {
    assert.equal(hasLoneSurrogate(line), false, "a surrogate pair was split across two lines");
    assert.equal(displayWidth(line) <= 21, true);
  }
});

test("A4: combining marks take no column", () => {
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("中"), 2);
  assert.equal(displayWidth("abc"), 3);
});

test("A4: a double-width status bar still ends inside the width", () => {
  const state = {
    ...emptyTuiState({ ...FACTS, sessionId: "中".repeat(40), model: "中".repeat(20) }),
  };
  const bar = barOf(renderFrame(state, 30));

  // Never wider than the terminal, and never wasteful either: a double-width
  // character can leave one column unused, which is the most a column-accurate
  // fit can be off.
  assert.equal(displayWidth(bar) <= 30, true, `${displayWidth(bar)} columns`);
});

test("A4: a combining mark travels with its base across a wrap", () => {
  const text = `${"b".repeat(19)}中\u0301x`;
  const state = { ...emptyTuiState(FACTS), lines: [{ tone: "assistant" as const, text }] };
  const body = bodyOf(renderFrame(state, 20));

  assert.equal(body[0], "b".repeat(19));
  assert.equal(body[1], "中\u0301x", "the mark was separated from the character it belongs to");
  assert.equal(displayWidth(body[1] ?? ""), 3);
});
