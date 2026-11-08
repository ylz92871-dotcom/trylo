import { displayWidth } from "./frame.js";
import { fitText } from "./text.js";

/**
 * The composer's view: the pure half of the input editor (WP23.2).
 *
 * Input is the composer state and the terminal width; output is the rows to
 * draw and where the cursor belongs. No IO and no clock — the same state
 * always renders the same rows, which is what makes the editor testable
 * without a terminal. The composer applies the redraw around these rows.
 *
 * Long lines scroll horizontally, the way a classic line editor does: the row
 * the cursor is on shows a window of the text around the cursor, and a row
 * without a cursor shows the head of its text. A row-level window keeps every
 * row inside the terminal without re-breaking the person's own newlines.
 */

export type ComposerView = {
  /** Buffer text and cursor offset, as the composer holds them. */
  readonly text: string;
  readonly cursor: number;
  /** The prompt on the first row; empty for a continuation or panel row. */
  readonly prompt: string;
  /** An extra row drawn under the buffer (history search), when present. */
  readonly footer: string | undefined;
};

export type ComposedRows = {
  readonly rows: ReadonlyArray<string>;
  /** Cursor placement: row index into `rows`, then columns from the left. */
  readonly cursorRow: number;
  readonly cursorColumn: number;
};

export function renderComposer(view: ComposerView, columns: number): ComposedRows {
  const width = Math.max(columns, 4);
  const lines = view.text.split("\n");
  const beforeCursor = view.text.slice(0, view.cursor);
  const cursorLine = beforeCursor.split("\n").length - 1;
  const cursorColumn = displayWidth(beforeCursor.split("\n")[cursorLine] ?? "");
  const rows: string[] = [];

  for (const [index, line] of lines.entries()) {
    const prefix = index === 0 ? view.prompt : "… ";
    const prefixWidth = displayWidth(prefix);
    const room = Math.max(width - prefixWidth, 1);

    if (index === cursorLine) {
      rows.push(`${prefix}${windowAround(line, cursorColumn, room)}`);
    } else {
      rows.push(`${prefix}${headOf(line, room)}`);
    }
  }

  let cursorRow = cursorLine;
  let cursorColumnDrawn = Math.min(cursorColumn + displayWidth(view.prompt), width - 1);

  if (view.footer !== undefined) {
    rows.push(fitText(view.footer, width - 1));
    cursorRow += 0;
  }

  // The cursor column is relative to the *window*, not the text: when a long
  // line scrolled, the cursor sits where the window put it.
  const line = lines[cursorLine] ?? "";
  const prefixWidth = displayWidth(cursorLine === 0 ? view.prompt : "… ");
  const window = windowFor(line, cursorColumn, Math.max(width - prefixWidth, 1));

  cursorColumnDrawn = Math.min(cursorColumn - window.startColumns + prefixWidth, width - 1);

  return { rows, cursorRow, cursorColumn: Math.max(cursorColumnDrawn, 0) };
}

/** The visible window of `line` with the cursor at `cursorColumn`. */
function windowAround(line: string, cursorColumn: number, room: number): string {
  const window = windowFor(line, cursorColumn, room);
  const characters = Array.from(line);
  const endUnits = unitsOf(characters, window.start + window.length);
  return line.slice(window.startUnits, endUnits);
}

function headOf(line: string, room: number): string {
  return fitText(line, room);
}

/**
 * Where a cursor window starts: the code-point offset, its own column width,
 * and the window's length in code points. Widths are terminal columns, so the
 * window stays honest on CJK text, where a code point is two columns.
 */
function windowFor(
  line: string,
  cursorColumn: number,
  room: number,
): { readonly start: number; readonly startUnits: number; readonly startColumns: number; readonly length: number } {
  const characters = Array.from(line);
  const widths = characters.map(displayWidth);
  const target = Math.max(cursorColumn - room + 1, 0);
  let start = 0;
  let startColumns = 0;

  while (start < characters.length && startColumns + (widths[start] ?? 0) <= target) {
    startColumns += widths[start] ?? 0;
    start += 1;
  }

  let length = 0;
  let lengthColumns = 0;
  let at = start;

  while (at < characters.length && lengthColumns + (widths[at] ?? 0) <= room) {
    lengthColumns += widths[at] ?? 0;
    length += 1;
    at += 1;
  }

  return { start, startUnits: unitsOf(characters, start), startColumns, length };
}

/** The UTF-16 offset of the `n`-th code point of a pre-split character list. */
function unitsOf(characters: ReadonlyArray<string>, n: number): number {
  let units = 0;

  for (const [index, character] of characters.entries()) {
    if (index >= n) {
      break;
    }
    units += character.length;
  }

  return units;
}

/**
 * The placeholder a large paste leaves in the buffer (WP23.2 / C81).
 *
 * A 4 000-character paste echoed into the frame pushes the conversation off
 * the screen and makes every redraw re-wrap four thousand columns. Legacy
 * solves it the same way: the buffer holds a one-line reference and the full
 * text is restored when the line is submitted. The threshold is legacy's
 * (800 characters or more than a screenful of lines).
 */
export const PASTE_PLACEHOLDER_CHARS = 800;
export const PASTE_PLACEHOLDER_LINES = 16;

export function pastePlaceholder(id: number, text: string): string | undefined {
  const lines = text.split("\n").length;
  if (text.length <= PASTE_PLACEHOLDER_CHARS && lines <= PASTE_PLACEHOLDER_LINES) {
    return undefined;
  }
  return `[Pasted text #${id} +${lines} lines]`;
}

/** The number in `[Pasted text #N …]`, or undefined for other text. */
export function pastePlaceholderId(token: string): number | undefined {
  const match = /^\[Pasted text #(\d+) \+\d+ lines\]$/.exec(token);
  return match === null ? undefined : Number(match[1]);
}
