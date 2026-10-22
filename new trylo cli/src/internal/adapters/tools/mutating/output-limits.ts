import { cutTailToBytes, cutToBytes } from "../../../protocol/text-cut.js";

/**
 * Truncating command output without lying about it.
 *
 * # What was wrong, measured rather than assumed
 *
 * The previous helper in `shell-spawn.ts` cut with `value.slice(0, maxBytes)`
 * and compared `value.length > maxBytes`. Both are UTF-16 code *units* while
 * every budget in this CLI is denominated in **bytes**. `evidence/2026-10-05-WP07/03-c14-truncation-probe.log`
 * reproduces it:
 *
 *   50 CJK characters, 100-byte budget  → 150 bytes returned  (budget broken)
 *   20 emoji, 30-byte budget             →  60 bytes returned  (budget broken)
 *
 * and two consequences that are worse than the overrun itself:
 *
 *  - **The tail was destroyed.** A build log's last line is the error. A 200-byte
 *    cut of a log ending `TAIL-ERROR: it failed` did not contain it.
 *  - **Nothing said what was lost.** The reader got a shorter string with no
 *    account of the gap, which is indistinguishable from "that was all there was".
 *
 * # What this does instead
 *
 * Codex's `utils/string/src/truncate.rs` keeps a prefix and a suffix and drops
 * the middle, because for command output the head says what ran and the tail
 * says what happened. Its `formatted_truncate_text` additionally reports the
 * original size. Both ideas are kept here; the byte arithmetic is Trylo's, since
 * `text-cut.ts` already owns "cut without breaking a character" and a second
 * implementation of that would be the duplication this repo forbids.
 */

/** How a truncation went, so a caller can report rather than infer. */
export type TruncationResult = {
  readonly text: string;
  readonly truncated: boolean;
  /** Bytes the original had, so the report is about the real input. */
  readonly originalBytes: number;
  /**
   * Bytes of the original that are **not in `text`** — the marker included.
   *
   * One meaning, in every branch: `originalBytes - byteLength(text)`. It used to
   * be `originalBytes - maxBytes`, which is a different number as soon as the
   * marker itself takes bytes out of the budget — a 5,000-byte input bounded to
   * 200 reported 4,800 while actually losing 4,772. The line branch reused the
   * byte stage's figure, so a result that lost 48,889 bytes to a line budget
   * reported `0`. Both were the same field meaning two different things.
   */
  readonly omittedBytes: number;
};

export type TruncationLimits = {
  readonly maxBytes: number;
  readonly maxLines?: number | undefined;
};

function markerFor(omittedBytes: number | undefined, omittedLines: number, byteFieldWidth = 0): string {
  const parts = omittedBytes === undefined ? [] : [`…${String(omittedBytes).padStart(byteFieldWidth, " ")} bytes omitted…`];
  if (omittedLines > 0) {
    parts.push(`${omittedLines} lines omitted`);
  }
  return `[${parts.join(", ")}]`;
}

/** What the marker itself costs, in bytes — the budget it has to be paid from. */
function markerCost(omittedBytes: number, omittedLines: number): number {
  return Buffer.byteLength(markerFor(omittedBytes, omittedLines), "utf8");
}

/**
 * Is there room in `budget` for a marker that reports `omittedBytes` honestly?
 *
 * The marker grows with the number it carries (`…500 bytes omitted…` is 25
 * bytes, the eight-digit worst case 31), so this measures rather than assumes.
 * It replaces a hardcoded `MARKER_OVERHEAD_BYTES = 64`, which was larger than
 * any marker actually built: every budget in 32..64 therefore took the degraded
 * branch and discarded a usable head and tail to save bytes that were never
 * needed, and at `maxBytes: 0` the result came out 26 bytes over budget
 * (`evidence/2026-10-05-WP07/15-f5-f6-arithmetic-probe.log`).
 */
function fitsMarker(budget: number, originalBytes: number): boolean {
  return budget >= markerCost(originalBytes, 0);
}

/**
 * A tiny budget still applies. The typed truncation flag carries the loss when
 * even a short human-readable marker cannot fit.
 */
function bareMarkerResult(originalBytes: number, maxBytes: number): TruncationResult {
  const text = cutToBytes("omitted", Math.min(maxBytes, originalBytes));
  return {
    text,
    truncated: true,
    originalBytes,
    omittedBytes: originalBytes - Buffer.byteLength(text, "utf8"),
  };
}

/**
 * Keep the head and the tail, drop the middle, and say how much went.
 *
 * The split is even because there is no principled reason to favour either end:
 * the head carries the invocation, the tail carries the outcome, and a caller
 * that needs more of one can re-run with a bigger budget rather than have this
 * guess for it.
 *
 * The marker is paid for **out of** `maxBytes`, never added on top — Codex's
 * prototype does the same (`split_budget(max_bytes)` hands the entire budget to
 * the two ends). A marker that pushed the result over the limit it announces
 * would be its own kind of lie.
 */
function truncateMiddle(text: string, maxBytes: number): TruncationResult {
  const originalBytes = Buffer.byteLength(text, "utf8");
  // The marker states how many bytes went, and it is itself part of the output,
  // so "how many went" and "how long is the marker" are two views of one number.
  // Reserving the pessimistic figure first and reporting the measured one after
  // would leave the two disagreeing — the marker would announce a size that
  // includes bytes it does not account for.
  //
  // So: measure the head and tail that fit beside a marker, then let the marker
  // report exactly the bytes those two left out. The reported figure and the
  // marker text are the same number by construction, not by coincidence.
  const reserve = markerCost(originalBytes, 0);
  const budget = Math.max(0, maxBytes - reserve);
  const head = cutToBytes(text, Math.ceil(budget / 2));
  // The tail must be measured from the real end, and `cutToBytes` only cuts a
  // prefix — so take the suffix by length and cut it to what the head left.
  const tail = cutTailToBytes(text, budget - Buffer.byteLength(head, "utf8"));
  // What is missing from the original, measured against the finished output —
  // which includes the marker. Measuring against `head + tail` instead would
  // credit the marker as kept bytes and under-report the loss by exactly its own
  // width (26 bytes here, at every budget). The field and the marker text then
  // state the same number, because the marker is built from this figure.
  const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  // Keep the reserved numeric field width even across 9/10 or 99/100. Without
  // padding, shortening the marker changes the very loss it claims to report.
  const marker = markerFor(originalBytes - keptBytes - reserve, 0, String(originalBytes).length);
  const omittedBytes = originalBytes - Buffer.byteLength(`${head}${marker}${tail}`, "utf8");
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    originalBytes,
    omittedBytes,
  };
}

/**
 * Apply a byte budget and an optional line budget to command output.
 *
 * Lines are cut *after* bytes, from the front, and only when the byte budget
 * alone left too many — a line budget on its own would drop the tail, which is
 * the part above.
 *
 * Every branch reports `omittedBytes` the same way (measured against the real
 * output), so a caller never has to ask which of the three branches produced the
 * number it is holding.
 */
export function truncateOutput(text: string, limits: TruncationLimits): TruncationResult {
  const maxBytes = Math.max(0, Math.trunc(limits.maxBytes));
  const originalBytes = Buffer.byteLength(text, "utf8");

  const byBytes: TruncationResult =
    originalBytes <= maxBytes
      ? { text, truncated: false, originalBytes, omittedBytes: 0 }
      : fitsMarker(maxBytes, originalBytes)
        ? truncateMiddle(text, maxBytes)
        : // No room for an honest marker. Say that something went without
          // inventing a size, and report the loss the same way every other
          // branch does — measured, not derived from the budget.
          bareMarkerResult(originalBytes, maxBytes);

  const maxLines = limits.maxLines;
  if (maxLines === undefined) {
    return byBytes;
  }
  const lineCap = Math.max(0, Math.trunc(maxLines));
  const lines = byBytes.text.split("\n");
  if (byBytes.text.length === 0 || lines.length <= lineCap) {
    return byBytes;
  }
  if (lineCap === 0) return { text: "", truncated: true, originalBytes, omittedBytes: originalBytes };
  if (lineCap <= 2) {
    // With no room for separate head/marker/tail lines, prefer the actual ending.
    const last = lines.at(-1) === "" ? lines.at(-2) ?? "" : lines.at(-1) ?? "";
    const text = cutTailToBytes(last, maxBytes);
    return { text, truncated: true, originalBytes, omittedBytes: originalBytes - Buffer.byteLength(text, "utf8") };
  }
  // Keep the head of what survived and the original tail, so the outcome is
  // still visible; the middle is where the volume was.
  const keptHead = lines.slice(0, Math.floor((lineCap - 1) / 2));
  const keptTailCount = lineCap - keptHead.length - 1;
  const keptTail = keptTailCount === 0 ? [] : lines.slice(lines.length - keptTailCount);
  const droppedLines = lines.length - keptHead.length - keptTail.length;
  const withMarker = [...keptHead, markerFor(undefined, droppedLines), ...keptTail].join("\n");
  // Inserting a line-loss marker must not spend bytes outside the byte budget.
  const text2 = Buffer.byteLength(withMarker, "utf8") <= maxBytes && Buffer.byteLength(withMarker, "utf8") <= originalBytes
    ? withMarker : [...keptHead, ...keptTail].join("\n");
  return {
    text: text2,
    truncated: true,
    originalBytes,
    // Measured again, because the line cut removed bytes the byte stage never
    // saw. Reporting the byte stage's figure here is what made a result that
    // lost 48,889 bytes claim it had lost none.
    omittedBytes: originalBytes - Buffer.byteLength(text2, "utf8"),
  };
}
