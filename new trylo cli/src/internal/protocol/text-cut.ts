/**
 * Cutting text to a byte budget without breaking a character.
 *
 * One implementation because two layers need the same guarantee and both got
 * it wrong the cheap way: `String.slice(n)` counts UTF-16 code units while
 * every limit in this CLI is denominated in bytes. On ASCII the two agree and
 * the bug sleeps; on a Chinese source file they do not, and the result is a
 * trailing `U+FFFD` — a replacement character spliced into the middle of a
 * token the model will then quote back.
 *
 * Traversal is by code point (`for…of`), so a character outside the BMP is
 * measured as the four bytes it actually occupies instead of the two surrogate
 * halves a code-unit walk would count.
 *
 * # Why it lives in `protocol/**`
 *
 * This started as `adapters/text-cut.ts` and was reimplemented a second time
 * inside `loop/tool-execution.ts` (`headWithin` / `tailWithin`), because `loop/**`
 * may not import `adapters/**` — the boundary scan (`verify.mjs:206`) rejects
 * `adapters` by name. Two copies of one rule is the duplication this repository
 * forbids, and nothing tied them together: they agreed today by coincidence.
 *
 * `protocol/**` is the layer both sides already import (`loop/compact-boundary.ts`
 * and `adapters/session-store/ndjson.ts` both import `protocol/transcript.js`)
 * and it is not on the banned list, so one copy can serve both. The old path
 * stays as a re-export so its five existing callers keep working.
 */

/**
 * The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`.
 *
 * A budget of zero yields the empty string rather than a partial character, and
 * a text that already fits is returned unchanged — the identity case is the one
 * that runs on every read.
 */
export function cutToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let used = 0;
  let end = 0;
  for (const character of text) {
    const cost = Buffer.byteLength(character, "utf8");
    if (used + cost > maxBytes) {
      break;
    }
    used += cost;
    end += character.length;
  }
  return text.slice(0, end);
}

/** The longest UTF-8 suffix that fits, without splitting a surrogate pair. */
export function cutTailToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let used = 0;
  let start = text.length;
  while (start > 0) {
    let previous = start - 1;
    const low = text.charCodeAt(previous);
    if (low >= 0xDC00 && low <= 0xDFFF && previous > 0) {
      const high = text.charCodeAt(previous - 1);
      if (high >= 0xD800 && high <= 0xDBFF) previous -= 1;
    }
    const cost = Buffer.byteLength(text.slice(previous, start), "utf8");
    if (used + cost > maxBytes) break;
    used += cost;
    start = previous;
  }
  return text.slice(start);
}

/**
 * `cutToBytes` plus the character count that was lost.
 *
 * The count is what makes a truncation honest: returning a shorter string with
 * no account of what is missing produces a file that looks complete.
 */
export function cutToBytesWithRemainder(text: string, maxBytes: number): {
  readonly text: string;
  readonly omittedCharacters: number;
} {
  const kept = cutToBytes(text, maxBytes);
  return { text: kept, omittedCharacters: text.length - kept.length };
}
