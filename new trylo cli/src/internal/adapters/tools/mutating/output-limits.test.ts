import assert from "node:assert/strict";
import { test } from "node:test";

import { truncateOutput } from "./output-limits.js";

/**
 * The four defects measured in `evidence/2026-10-05-WP07/03-c14-truncation-probe.log`,
 * each pinned here so a regression names itself.
 */

const BUDGET = 100;

test("a byte budget is a byte budget: CJK output does not overrun it", () => {
  // The defect: `value.length > maxBytes` counted UTF-16 units, so 50 CJK
  // characters (150 bytes) passed a 100-byte budget untouched.
  const cjk = "中".repeat(50);
  const result = truncateOutput(cjk, { maxBytes: BUDGET });

  assert.ok(
    Buffer.byteLength(result.text, "utf8") <= BUDGET,
    `expected <= ${BUDGET} bytes, got ${Buffer.byteLength(result.text, "utf8")}`,
  );
  assert.equal(result.truncated, true);
});

test("characters outside the BMP are measured as the four bytes they occupy", () => {
  // Emoji are surrogate pairs: two UTF-16 units, four UTF-8 bytes.
  const emoji = "👍".repeat(40);
  const result = truncateOutput(emoji, { maxBytes: 40 });

  assert.ok(
    Buffer.byteLength(result.text, "utf8") <= 40,
    `expected <= 40 bytes, got ${Buffer.byteLength(result.text, "utf8")}`,
  );
  assert.equal(result.text.includes("�"), false, "a cut must not leave a replacement character");
});

test("the tail survives: the error at the end of a log is the point of it", () => {
  const log = `HEAD-MARKER\n${"noise\n".repeat(400)}TAIL-ERROR: it failed\n`;
  const result = truncateOutput(log, { maxBytes: 300 });
  assert.ok(result.text.includes("HEAD-MARKER"), "the head must survive");
  assert.ok(result.text.includes("TAIL-ERROR"), "the tail — the actual error — must survive");
});

test("a truncation says what it lost, so it cannot read as the whole output", () => {
  const result = truncateOutput("x".repeat(5000), { maxBytes: 200 });
  assert.equal(result.truncated, true);
  assert.match(result.text, /omitted/, "the marker must state that something was removed");
  assert.ok(result.omittedBytes > 0);
  assert.equal(result.originalBytes, 5000);
});

test("output that fits is returned byte for byte, with no marker added", () => {
  const text = "all of it";
  const result = truncateOutput(text, { maxBytes: 1000 });
  assert.equal(result.text, text);
  assert.equal(result.truncated, false);
  assert.equal(result.omittedBytes, 0);
});

test("one huge line with no newline anywhere is still bounded", () => {
  // No line structure to lean on: the byte budget alone has to hold.
  const result = truncateOutput("y".repeat(200_000), { maxBytes: 1000 });
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 1000);
  assert.equal(result.truncated, true);
});

test("a line budget also keeps the tail rather than dropping it", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const result = truncateOutput(text, { maxBytes: 100_000, maxLines: 20 });

  assert.equal(result.truncated, true);
  const lines = result.text.split("\n");

  assert.ok(lines.length <= 22, `expected about 20 lines, got ${lines.length}`);
  assert.ok(result.text.includes("line 0"), "head survives");
  assert.ok(result.text.includes("line 499"), "tail survives");
});

test("a budget too small to hold a marker says so instead of faking one", () => {
  const result = truncateOutput("z".repeat(500), { maxBytes: 8 });
  assert.equal(result.truncated, true);
  assert.match(result.text, /omitted|bytes/);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 40, "even the degenerate case stays small");
});

/**
 * F6: the degraded branch used a hardcoded `MARKER_OVERHEAD_BYTES = 64`, which
 * is larger than any marker it actually builds (`…500 bytes omitted…` is 25
 * bytes, the 8-digit worst case 31). Two consequences, both measured in
 * `evidence/2026-10-05-WP07/15-f5-f6-arithmetic-probe.log`:
 *
 *  - every budget in 32..64 took the degraded branch and threw away a usable
 *    head and tail to save bytes that were never needed;
 *  - at `maxBytes: 0` the result was 26 bytes — 26 over the budget.
 *
 * So the invariant is asserted across the whole range rather than at one budget:
 * the result never exceeds the budget, except where honesty genuinely costs
 * more than the budget, and then only by the marker's own width.
 */
test("no budget in 0..80 is silently exceeded, and none loses its tail needlessly", () => {
  for (let budget = 0; budget <= 80; budget += 1) {
    const text = `${"HEAD".repeat(40)}noise${"TAIL-ERROR".repeat(40)}`;
    const result = truncateOutput(text, { maxBytes: budget });
    const out = Buffer.byteLength(result.text, "utf8");

    assert.equal(result.truncated, true, `budget ${budget} must report a truncation`);

    // The one permitted excess is a marker that cannot fit in the budget at
    // all; anything above the marker's own width is a bug.
    if (out > budget) {
      assert.ok(
        out <= Math.max(budget, 32),
        `budget ${budget}: result is ${out} bytes, over both the budget and the marker's width`,
      );
    }

    // Both ends survive as soon as the budget can hold the marker *and* a piece
    // of each end. Measured, not assumed: at 32 the head is "HEAD" but only "R"
    // of the tail fits, because the budget is split between the two ends and a
    // ten-character token does not fit in three.
    if (budget >= 64) {
      assert.ok(
        result.text.includes("HEAD") && result.text.includes("TAIL"),
        `budget ${budget} has room for both ends, so both must survive`,
      );
    }
  }
});

/**
 * F5: `omittedBytes` had three meanings and none of them was the truth.
 *
 * It was computed as `originalBytes - maxBytes`, which ignores that the marker
 * itself is paid for out of the budget, so the figure was always too small; and
 * the line branch reused the byte stage's number, so a result that shed 48,889
 * bytes to a line budget reported `0`. One definition now: bytes of the original
 * that are not in the output.
 */
test("omittedBytes is measured, not derived: one meaning in every branch", () => {
  for (const maxBytes of [40, 100, 200, 1000, 4000]) {
    const result = truncateOutput("x".repeat(5000), { maxBytes });

    assert.equal(
      result.omittedBytes,
      result.originalBytes - Buffer.byteLength(result.text, "utf8"),
      `byte branch at ${maxBytes}: the field must equal what actually went`,
    );
    assert.ok(result.omittedBytes > 0, `byte branch at ${maxBytes}: something was removed`);
  }
});

test("the line branch reports the bytes it removed, not the byte stage's figure", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const result = truncateOutput(text, { maxBytes: 100_000, maxLines: 20 });

  assert.equal(result.truncated, true);
  assert.ok(
    result.omittedBytes > 10_000,
    `expected a five-figure loss, got ${result.omittedBytes} — the byte stage's 0 leaked through`,
  );
  assert.equal(
    result.omittedBytes,
    result.originalBytes - Buffer.byteLength(result.text, "utf8"),
    "same definition as the byte branch",
  );
});

test("the marker states the same number the field reports", () => {
  const result = truncateOutput("x".repeat(5000), { maxBytes: 200 });
  assert.ok(
    result.text.includes(`${result.omittedBytes} bytes omitted`),
    `marker must carry ${result.omittedBytes}, got: ${result.text}`,
  );
});

test("a cut never splits a character, whatever the alphabet", () => {
  for (const sample of ["中".repeat(200), "👍".repeat(200), "é".repeat(200), "𝔘".repeat(200)]) {
    for (const budget of [1, 7, 33, 64, 129, 512]) {
      const result = truncateOutput(sample, { maxBytes: budget });
      assert.equal(
        result.text.includes("�"),
        false,
        `replacement character at budget ${budget} for ${JSON.stringify(sample.slice(0, 2))}`,
      );
    }
  }
});
