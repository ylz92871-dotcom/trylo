import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_READ_ONLY_LIMITS, type ReadOnlyToolLimits } from "./limits.js";
import {
  isRangeProblem,
  readRangeRequest,
  selectRange,
  type RangeRequest,
} from "./range.js";

/**
 * WP-CLI-B1 §4: a model can read past line 2000 and keep going.
 *
 * These are unit tests on the selection function, deliberately free of any file
 * system, because the thing worth pinning down here is *arithmetic*: which lines
 * come back, what the model is told about them, and where it goes next. The end to
 * end behaviour through the real tool is proved in `range-tool.test.ts`.
 */

const LIMITS: ReadOnlyToolLimits = { ...DEFAULT_READ_ONLY_LIMITS };

/**
 * Counting lines by `split("\n")` counts the empty string after a trailing
 * newline as a line. Every range read ends in a real line's terminator, so the
 * count is always one more than the number of lines that came back.
 */
function returnedLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length - 1;
}

/** `count` lines, each `line N`, LF-terminated — the shape of a normal source file. */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}

function ask(offset: number, limit?: number): RangeRequest {
  return limit === undefined ? { offset, limit: undefined } : { offset, limit };
}

/* ------------------------------------------------------------------ parsing */

test("absent offset and limit mean the top of the file and the existing ceiling", () => {
  const parsed = readRangeRequest({});
  assert.deepEqual(parsed, { offset: 0, limit: undefined });
});

test("offset must be a non-negative integer, and says which way it was wrong", () => {
  const negative = readRangeRequest({ offset: -1 });

  assert.ok(isRangeProblem(negative));
  assert.equal(negative.reason, "offset_negative");

  const fractional = readRangeRequest({ offset: 1.5 });

  assert.ok(isRangeProblem(fractional));
  assert.equal(fractional.reason, "offset_not_integer");

  const text = readRangeRequest({ offset: "3" });

  assert.ok(isRangeProblem(text));
  assert.equal(text.reason, "offset_not_integer");
});

test("limit must be a positive integer; zero is a mistake worth reporting", () => {
  const zero = readRangeRequest({ limit: 0 });

  assert.ok(isRangeProblem(zero));
  assert.equal(zero.reason, "limit_not_positive");

  const negative = readRangeRequest({ limit: -5 });

  assert.ok(isRangeProblem(negative));
  assert.equal(negative.reason, "limit_not_positive");
});

/* --------------------------------------------------------------- selection */

test("the default read is the first 2000 lines, unchanged from before", () => {
  const source = lines(2600);
  const selection = selectRange(source, ask(0), LIMITS);

  assert.equal(selection.startLine, 1);
  assert.equal(selection.endLine, 2000);
  assert.equal(selection.truncated, true);
  assert.equal(selection.nextOffset, 2000);
  // The text is exactly the first 2000 lines *including their terminators*,
  // which is the pre-existing behaviour `{path}`-only callers depend on. Not
  // `join("\n")`: that would drop the 2000th line's newline and stop being the
  // same bytes the file has.
  assert.equal(selection.text, source.split("\n").slice(0, 2000).join("\n") + "\n");
  assert.equal(returnedLines(selection.text), 2000);
  assert.equal(selection.text.endsWith("line 2000\n"), true);
});

/**
 * The property that makes an edit written against a range read land correctly:
 * concatenating every range of a file reproduces the file. If this fails, no
 * `edit_file` match a model writes against a read is reliable.
 */
test("walking the whole file in ranges reproduces it byte for byte", () => {
  const source = lines(2600);
  const chunks: string[] = [];
  let request = ask(0);

  for (let guard = 0; guard < 10; guard += 1) {
    const selection = selectRange(source, request, LIMITS);
    chunks.push(selection.text);
    if (selection.nextOffset === undefined) {
      break;
    }
    request = ask(selection.nextOffset);
  }

  assert.equal(chunks.join(""), source, "the ranges reassemble into the original file");
});

test("an explicit offset reads that region and points at the next one", () => {
  const source = lines(2600);
  const selection = selectRange(source, ask(2579, 80), LIMITS);

  assert.equal(selection.startLine, 2580);
  // 21 lines remain, not 80: the request is honoured up to the end of the file
  // rather than padded with lines that do not exist.
  assert.equal(selection.endLine, 2600);
  assert.equal(selection.totalLines, 2600);
  assert.equal(selection.truncated, false, "the request was satisfied, not cut short");
  assert.equal(selection.nextOffset, undefined, "nothing follows the end of the file");
  assert.equal(selection.text.split("\n")[0], "line 2580");
  assert.equal(returnedLines(selection.text), 21);
  assert.equal(selection.text.endsWith("line 2600\n"), true);

  // A window in the middle is the case that matters: it stops where the model
  // asked and points at what comes next.
  const middle = selectRange(source, ask(100, 80), LIMITS);

  assert.equal(middle.startLine, 101);
  assert.equal(middle.endLine, 180);
  assert.equal(middle.truncated, true);
  assert.equal(middle.nextOffset, 180);
});

/**
 * The workflow WP §4 names, end to end in memory: a model reads the head, is told
 * where to continue, and arrives at the target without ever estimating a number.
 */
test("following nextOffset walks the file without repeating a line", () => {
  const source = lines(2600);
  const seen: string[] = [];
  let request = ask(0);

  for (let guard = 0; guard < 10; guard += 1) {
    const selection = selectRange(source, request, LIMITS);
    const chunk = selection.text === "" ? [] : selection.text.slice(0, -1).split("\n");

    seen.push(...chunk);

    if (selection.nextOffset === undefined) {
      break;
    }

    request = ask(selection.nextOffset);
  }

  assert.equal(seen.length, 2600);
  assert.equal(new Set(seen).size, 2600, "no line was returned twice");
  assert.equal(seen[0], "line 1");
  assert.equal(seen.at(-1), "line 2600");
});

test("the last chunk reports no nextOffset, so the model cannot loop forever", () => {
  const selection = selectRange(lines(2600), ask(2500, 200), LIMITS);
  assert.equal(selection.endLine, 2600);
  assert.equal(selection.nextOffset, undefined);
  assert.equal(selection.truncated, false);
});

test("an offset past the end returns nothing and does not pretend otherwise", () => {
  const selection = selectRange(lines(10), ask(9000), LIMITS);

  assert.equal(selection.text, "");
  assert.equal(selection.totalLines, 10);
  // Not line 1: a range that began at 9000 did not begin at line 1, and saying
  // so would have the model reading the top of the file believing it got there.
  assert.equal(selection.startLine, 0);
  assert.equal(selection.nextOffset, undefined);
  assert.equal(selection.truncated, false);
});

test("an empty selection still reports a range, never an inverted one", () => {
  // `startLine` is the position asked for and `endLine` is the last line actually
  // returned. When nothing comes back they have to land on the same line: a
  // selection whose end precedes its start is not a position any caller — least
  // of all a model computing its next `offset` from them — can make sense of.
  const past = selectRange(lines(10), ask(9000), LIMITS);

  assert.equal(past.endLine, past.startLine);

  const empty = selectRange("", ask(0), LIMITS);

  assert.equal(empty.startLine, empty.endLine);

  const atEnd = selectRange(lines(10), ask(10), LIMITS);

  assert.equal(atEnd.text, "");
  assert.equal(atEnd.startLine, 0);
  assert.equal(atEnd.endLine, 0);
});

test("an empty file reports no lines rather than one empty line", () => {
  const selection = selectRange("", ask(0), LIMITS);
  assert.equal(selection.totalLines, 0);
  assert.equal(selection.text, "");
  assert.equal(selection.nextOffset, undefined);
  assert.equal(selection.truncated, false);
});

test("a file with no trailing newline keeps its last line", () => {
  const source = "alpha\nbravo\ncharlie";
  const selection = selectRange(source, ask(0), LIMITS);
  assert.equal(selection.totalLines, 3);
  assert.equal(selection.text, source);
  assert.equal(selection.endLine, 3);
});

/* ------------------------------------------------------ CRLF and encoding */

test("CRLF line endings survive a range read byte for byte", () => {
  // `edit_file` matches against `content`; normalising the line endings would be a
  // silent rewrite of the user's file disguised as a read. A line comes back with
  // the terminator that actually followed it — `\r` included, and never stranded
  // inside the line as a stray character.
  const source = "one\r\ntwo\r\nthree\r\n";
  const selection = selectRange(source, ask(1, 1), LIMITS);

  assert.equal(selection.text, "two\r\n");
  assert.equal(selection.text.includes("two\r\r"), false);
  assert.equal(selection.startLine, 2);
  assert.equal(selection.endLine, 2);

  const whole = selectRange(source, ask(0), LIMITS);

  assert.equal(whole.text, "one\r\ntwo\r\nthree\r\n");
  assert.equal(whole.totalLines, 3);
  // Round trip: the ranges reassemble into the file they came from.
  const second = selectRange(source, ask(1), LIMITS);

  assert.equal(whole.text + second.text, source + "two\r\nthree\r\n");
});

test("a file mixing LF and CRLF keeps each line's own terminator", () => {
  // Two machines editing one file really do produce this, and assuming one style
  // would rewrite every line of the other kind.
  const source = "a\nb\r\nc\n";
  const selection = selectRange(source, ask(0), LIMITS);
  assert.equal(selection.text, source);
  assert.equal(selection.totalLines, 3);
});

test("a range read preserves every byte of the source when nothing is cut", () => {
  const source = "x".repeat(1000) + "\n" + "y".repeat(1000) + "\n";
  const whole = selectRange(source, ask(0), LIMITS);
  // All of it, trailing newline included — this is the property the other CRLF
  // tests depend on, stated on its own: a read that quietly drops the file's
  // last byte is a read that cannot be written back against.
  assert.equal(whole.text, source);
});

/* ------------------------------------------------------ the byte ceiling */

test("a Chinese file is cut on a character boundary, never mid-character", () => {
  // Each line is 3 characters = 9 bytes. A 20-byte budget fits two whole lines
  // (18 bytes) and cannot fit a third.
  const source = `${"中文文\n".repeat(5)}`;
  const selection = selectRange(source, ask(0), { ...LIMITS, maxBytes: 20 });

  assert.equal(selection.text.includes("�"), false, "no replacement character may appear");

  for (const character of selection.text) {
    assert.ok(Buffer.byteLength(character, "utf8") <= 3);
  }

  assert.equal(Buffer.byteLength(selection.text, "utf8") <= 20, true);
});

test("one line longer than the byte budget is reported, not paginated", () => {
  // The failure WP §4 names: a `nextOffset` into the middle of a line would let a
  // model spend turns making no progress. Line 2 is 5000 bytes against a 200 byte
  // budget, so no offset can ever produce it.
  const source = "short\n" + "x".repeat(5_000) + "\ntail\n";
  const selection = selectRange(source, ask(0), { ...LIMITS, maxBytes: 200 });

  assert.equal(selection.lineTooLong?.line, 2);
  assert.equal(selection.nextOffset, undefined, "no fake position inside a long line");
  // The length reported is the line's real length, not the remnant that survived
  // the cut. A model deciding whether another approach is worth it needs the
  // former; the latter would suggest a 200 byte line had been refused.
  assert.equal(selection.lineTooLong?.bytes, 5001, "the whole line, terminator included");
  // WP §4 rules out paging through it with byte offsets; it does not ask for a
  // blank read. The prefix that fits comes back, so the model can at least see
  // what kind of line it is — an empty `content` would make a long line
  // indistinguishable from a missing file.
  assert.equal(selection.text.startsWith("short\n"), true, "the lines before it come back whole");
  assert.equal(Buffer.byteLength(selection.text, "utf8"), 200, "exactly the budget, no more");
  assert.equal(selection.text.endsWith("x".repeat(50)), true, "and the prefix of the long line");
  assert.equal(selection.truncated, true);
});

test("a single line larger than the whole budget is not read as an empty file", async () => {
  // A minified bundle or a long data line: one line, no newline, bigger than the
  // ceiling. Before this was fixed the read came back with `content: ""`, which a
  // model cannot tell apart from a file that does not exist.
  const source = "c".repeat(60_000);
  const selection = selectRange(source, ask(0), { ...LIMITS, maxBytes: 49_150 });

  assert.equal(selection.totalLines, 1);
  assert.ok(selection.text.length > 30_000, `content was starved: ${selection.text.length}`);
  assert.equal(Buffer.byteLength(selection.text, "utf8") <= 49_150, true);
  assert.equal(selection.lineTooLong?.line, 1);
  assert.equal(selection.lineTooLong?.bytes, 60_000);
  assert.equal(selection.nextOffset, undefined, "there is nowhere forward to go");
  assert.equal(selection.truncatedBytes, true);
});

/**
 * The bug this file was written to catch, in the shape it actually appeared in.
 *
 * A perfectly ordinary 100-line file read against a 200 byte budget: line 26 ends
 * at byte 199, so the 200 byte cut lands one byte into line 27 — an 8 byte line
 * that would have fitted in any budget with room to spare. Reporting that as "too
 * long" and withholding `nextOffset` leaves the model with nowhere to go on a file
 * it could have finished, and the next offset it guesses lands mid-line again just
 * as often. Running out of budget in the middle of a line is ordinary; a line that
 * cannot fit a budget *by itself* is the only real dead end.
 */
test("running out of budget mid-line still hands back a way forward", () => {
  const source = lines(100);
  const budget = { ...LIMITS, maxBytes: 200 };
  const first = selectRange(source, ask(0), budget);

  assert.equal(first.lineTooLong, undefined, "an 8 byte line is not too long for a 200 byte budget");
  assert.ok(first.nextOffset !== undefined, "the read must not dead-end here");
  assert.equal(first.nextOffset, first.endLine, "continuing means 'after the last line you got'");
  assert.equal(Buffer.byteLength(first.text, "utf8") <= 200, true);

  // And following it actually finishes the file, byte for byte — the property a
  // dead-end would have broken.
  const chunks: string[] = [];
  let request = ask(0);

  for (let guard = 0; guard < 40; guard += 1) {
    const step = selectRange(source, request, budget);
    chunks.push(step.text);
    if (step.nextOffset === undefined) {
      break;
    }
    request = ask(step.nextOffset);
  }

  assert.equal(chunks.join(""), source, "a tight byte budget must not make a file unreadable");
});

test("a whole number of lines that overflows the budget keeps nextOffset", () => {
  // The clean-cut case: the budget ended exactly between lines, so every kept line
  // is whole and the next one is untouched. In `lines(100)` the running byte count
  // is 199 after line 26 and 207 after line 27, so a 207 byte budget ends exactly
  // on a boundary and a 205 byte one does not.
  const source = lines(100);
  const selection = selectRange(source, ask(0), { ...LIMITS, maxBytes: 207 });

  assert.equal(selection.lineTooLong, undefined);
  assert.equal(selection.truncatedBytes, true);
  assert.equal(selection.text.endsWith("\n"), true, "the cut fell on a line boundary");
  assert.equal(selection.text.endsWith("line 27\n"), true, "every line came back whole");
  assert.ok(selection.nextOffset !== undefined);
  assert.equal(selection.nextOffset, 27, "0-based, so the line after the 27th");
  assert.equal(Buffer.byteLength(selection.text, "utf8"), 207);
});

test("limit is honoured even when the bytes would allow far more", () => {
  const selection = selectRange(lines(500), ask(10, 5), LIMITS);
  assert.equal(selection.startLine, 11);
  assert.equal(selection.endLine, 15);
  assert.equal(returnedLines(selection.text), 5);
  assert.equal(selection.nextOffset, 15);
});

test("a limit larger than what is left returns the rest and stops", () => {
  const selection = selectRange(lines(20), ask(15, 1000), LIMITS);
  assert.equal(selection.startLine, 16);
  assert.equal(selection.endLine, 20);
  assert.equal(selection.nextOffset, undefined);
  assert.equal(selection.truncated, false);
});

test("totalLines is reported so the model knows the size it is walking", () => {
  assert.equal(selectRange(lines(2600), ask(0, 10), LIMITS).totalLines, 2600);
  assert.equal(selectRange("", ask(0), LIMITS).totalLines, 0);
  assert.equal(selectRange("one", ask(0), LIMITS).totalLines, 1);
});
