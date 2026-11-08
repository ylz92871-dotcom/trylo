import { statusBar } from "./status-bar.js";
import type { TuiLine, TuiState } from "./state.js";
import { noPaint, type TuiPaint } from "./theme.js";

/**
 * The frame renderer: the TUI's pure half.
 *
 * Input is the frame state and the terminal width; output is one frame of
 * text with the status bar dimmed. No IO, no clock, no randomness — the same
 * state and width always render byte-for-byte the same frame, which is what
 * makes the rendering half testable without a terminal (work-package
 * contract #1).
 *
 * The status bar keeps its ANSI dimming; content lines are plain text so a
 * hard wrap can never cut an escape sequence in half.
 *
 * Wrapping and truncation measure **terminal columns**, not UTF-16 code units
 * (WP D4). Before that, `"中".repeat(50)` at width 80 was one 50-unit line that
 * a terminal then wrapped into two lines it had not been told about, and the
 * frame the shell believed it had drawn was not the frame on screen. The width
 * table below is written out rather than imported: this build adds no runtime
 * dependency, so it carries the ranges it needs and says which ones it carries.
 */

export const DEFAULT_WIDTH = 80;
/** Below this a terminal is unreadable; clamp instead of wrapping to slivers. */
const MIN_WIDTH = 10;

/**
 * `paint` is a parameter rather than a property of the state because colour is
 * a fact about the terminal, not about the turn: the same state renders with
 * sequences on a terminal and without them in a pipe or under `NO_COLOR`. It
 * defaults to `noPaint`, so every caller that does not ask for colour gets
 * byte-for-byte the frame this renderer always produced.
 */
export function renderFrame(
  state: TuiState,
  width: number,
  paint: TuiPaint = noPaint,
  tick = 0,
): string {
  const columns = columnsOf(width);
  const body = [...state.lines, ...provisional(state.pending)].flatMap((line) =>
    paintedLines(line, columns, paint),
  );
  const bar = dim(truncate(statusBar(state, columns, tick), columns));
  return [...body, "", bar, ""].join("\n");
}

/**
 * The message still streaming in, as the rows it has so far.
 *
 * A turn that answers for thirty seconds used to show nothing of that answer
 * until its message closed — the screen said "running" while the model was
 * already halfway through a paragraph a person was waiting to read. These rows
 * are provisional plain text: the markdown pass runs at `message_end`, when
 * the text is complete and a table's borders would not realign mid-word.
 */
function provisional(pending: TuiState["pending"]): ReadonlyArray<TuiLine> {
  if (pending === undefined || pending.text.length === 0) {
    return [];
  }
  return pending.text.split("\n").map((text) => ({ tone: "assistant", text }));
}

/**
 * Wrap first, then paint: the order is the whole safety argument.
 *
 * `wrapLine` measures columns, and an escape sequence has none of its own — so
 * a line painted *before* wrapping would be measured wider than it looks and
 * wrapped in the wrong place, and a line wrapped after painting could have its
 * closing sequence pushed onto the next row. Painting each already-wrapped row
 * keeps both halves of every sequence on the same row and keeps the column
 * count honest.
 */
function paintedLines(line: TuiLine, columns: number, paint: TuiPaint): ReadonlyArray<string> {
  return wrapLine(decorate(line), columns).map((wrapped) => paint(line.tone, wrapped));
}

/**
 * The marker a line carries in its text, not in its colour.
 *
 * The person's own words get `> `, which is what the prompt they typed after
 * already looks like, and it survives a terminal with no colour and a frame
 * copied into a chat window. Nothing else is marked: the model's answer is
 * most of the screen, and prefixing it would prefix everything.
 */
function decorate(line: TuiLine): string {
  return line.tone === "user" ? `> ${line.text}` : line.text;
}

/**
 * One turn's own lines — everything from `before` on — as the live region the
 * shell repaints (WP D3).
 *
 * The status bar is optional because the two paints want different things: a
 * paint *during* a turn carries the bar so iteration and tool progress are
 * visible while the model is still talking, while the paint that settles the
 * turn leaves only content, so the shell's next prompt draws the bar exactly
 * once, as it always did.
 */
export function renderTurnBody(
  state: TuiState,
  before: number,
  width: number,
  withStatus: boolean,
  paint: TuiPaint = noPaint,
  tick = 0,
): string {
  const columns = columnsOf(width);
  const content = [...state.lines.slice(before), ...provisional(state.pending)].flatMap((line) =>
    paintedLines(line, columns, paint),
  );

  if (!withStatus) {
    return content.join("\n");
  }

  return [...content, dim(truncate(statusBar(state, columns, tick), columns))].join("\n");
}

function columnsOf(width: number): number {
  return width < MIN_WIDTH ? MIN_WIDTH : width;
}

/**
 * Split on newlines first, then wrap any line wider than the terminal.
 *
 * Iteration is by code point, so a surrogate pair is never cut in half; a
 * character is always kept whole, even when it is wider than the terminal.
 */
export function wrapLine(text: string, columns: number): ReadonlyArray<string> {
  const parts: string[] = [];

  for (const segment of text.split("\n")) {
    let line = "";
    let width = 0;

    for (const character of segment) {
      const size = widthOf(character);
      if (width + size > columns && line.length > 0) {
        parts.push(line);
        line = "";
        width = 0;
      }

      line += character;
      width += size;
    }

    // An empty segment is a blank line worth keeping; a segment that exactly
    // filled the terminal is already pushed and must not push a second time.
    if (line.length > 0 || segment.length === 0) {
      parts.push(line);
    }
  }

  return parts.length === 0 ? [""] : parts;
}

function truncate(text: string, columns: number): string {
  if (displayWidth(text) <= columns) {
    return text;
  }
  return `${fit(text, columns - 1)}…`;
}

/** The longest prefix of `text` that fits in `columns` terminal columns. */
function fit(text: string, columns: number): string {
  let taken = "";
  let width = 0;

  for (const character of text) {
    const size = widthOf(character);
    if (width + size > columns) {
      break;
    }
    taken += character;
    width += size;
  }

  return taken;
}

/** Terminal columns a string occupies. Iterates code points, never units. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += widthOf(character);
  }
  return width;
}

/**
 * Columns one code point occupies: 0 for combining marks, 2 for East Asian
 * Wide/Fullwidth, 1 otherwise.
 *
 * The ranges carried here are the ones this build has to get right — CJK,
 * Hangul, fullwidth forms, the common emoji blocks, and the combining and
 * zero-width ranges that appear in real text. It is deliberately not the whole
 * of UAX #11: the full table is thousands of entries and would be a dependency
 * in all but name. A code point outside it is measured as 1, which is the same
 * answer the previous implementation gave for everything.
 */
function widthOf(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (isZeroWidth(code)) {
    return 0;
  }
  return isWide(code) ? 2 : 1;
}

/** Combining marks, variation selectors and zero-width formatting. */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritical marks
    (code >= 0x1ab0 && code <= 0x1aff) || // combining diacritical marks extended
    (code >= 0x1dc0 && code <= 0x1dff) || // combining diacritical marks supplement
    (code >= 0x20d0 && code <= 0x20ff) || // combining marks for symbols
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) || // combining half marks
    (code >= 0x200b && code <= 0x200f) || // zero-width space through RTL mark
    (code >= 0x1f3fb && code <= 0x1f3ff) || // emoji skin-tone modifiers
    code === 0xfeff // zero-width no-break space
  );
}

/** East Asian Wide and Fullwidth ranges, plus the emoji blocks in common use. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo initial consonants
    (code >= 0x2e80 && code <= 0x2eff) || // CJK radicals supplement
    (code >= 0x2f00 && code <= 0x2fdf) || // Kangxi radicals
    (code >= 0x2ff0 && code <= 0x2fff) || // ideographic description characters
    (code >= 0x3000 && code <= 0x303e) || // CJK symbols and punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana, Bopomofo, Hangul compat, CJK compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK unified ideographs extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi syllables and radicals
    (code >= 0xa960 && code <= 0xa97f) || // Hangul Jamo extended-A
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe10 && code <= 0xfe19) || // vertical forms
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) || // fullwidth signs
    (code >= 0x1f300 && code <= 0x1f64f) || // pictographs, emoticons
    (code >= 0x1f680 && code <= 0x1f6ff) || // transport
    (code >= 0x1f900 && code <= 0x1f9ff) || // supplemental symbols and pictographs
    (code >= 0x20000 && code <= 0x2fffd) || // CJK unified ideographs extension B+
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}
