import { displayWidth } from "./frame.js";
import type { MarkdownLine } from "./markdown.js";

/**
 * The markdown table layout (WP23.1 / L43).
 *
 * Split out of `markdown.ts` because a table is the one block whose rendering
 * depends on the terminal's width and on width arithmetic of its own; the rest
 * of the renderer is a per-line translation. The column distribution is the
 * legacy `MarkdownTable` algorithm, ported as-is: ideal widths when everything
 * fits, minimum widths plus a proportional share of the leftovers when they do
 * not, and a proportional shrink that allows hard wraps when even the minimums
 * overflow.
 *
 * Width arithmetic uses the frame's own `displayWidth`, so a table aligned here
 * is a table aligned on a CJK terminal — and the rows it produces are never
 * wider than the width it was handed, which keeps the frame's wrap from
 * re-breaking a table whose alignment it cannot preserve.
 */

/** A table starts at `start` when the row carries cells and the next is a rule. */
export function isTableAt(rows: ReadonlyArray<string>, start: number): boolean {
  const row = rows[start] ?? "";
  if (!row.includes("|")) {
    return false;
  }
  const separator = rows[start + 1] ?? "";
  return /^\s*\|?\s*:?-{3,}.*\|/.test(separator) || /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(separator);
}

/** Render the table beginning at `start`; returns the index after its last row. */
export function tableBlock(
  rows: ReadonlyArray<string>,
  start: number,
  columns: number,
  out: MarkdownLine[],
): number {
  const header = cellsOf(rows[start] ?? "");
  const separator = rows[start + 1] ?? "";
  const aligns = alignsOf(separator, header.length);
  const body: string[][] = [];
  let index = start + 2;

  while (index < rows.length) {
    const row = rows[index] ?? "";
    if (row.trim().length === 0 || !row.includes("|")) {
      break;
    }
    body.push(cellsOf(row));
    index += 1;
  }

  out.push(...renderTable(header, body, aligns, columns));

  return index;
}

/** Split one table row into cells; an escaped pipe stays in its cell. */
function cellsOf(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";

  for (let i = 0; i < trimmed.length; i += 1) {
    const character = trimmed[i] ?? "";
    if (character === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }

    if (character === "|") {
      cells.push(normalizeCell(current.trim()));
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(normalizeCell(current.trim()));

  return cells;
}

function alignsOf(separator: string, columnCount: number): ReadonlyArray<"left" | "right" | "center"> {
  const cells = cellsOf(separator);
  return Array.from({ length: columnCount }, (_, i) => {
    const cell = cells[i] ?? "";
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

const MIN_COLUMN_WIDTH = 3;
/**
 * Border cells keep two padding spaces each and the layout keeps one column of
 * slack, so a table that measures exactly `columns` wide is not re-wrapped by
 * the frame by accident.
 */
const TABLE_SAFETY_MARGIN = 1;

/**
 * The column layout, ported from the legacy `MarkdownTable` (its three-step
 * distribution): ideal widths when everything fits; minimum widths plus a
 * proportional share of the leftovers when they do not; a proportional shrink
 * that allows hard wraps when even the minimums overflow.
 */
function renderTable(
  header: ReadonlyArray<string>,
  body: ReadonlyArray<ReadonlyArray<string>>,
  aligns: ReadonlyArray<"left" | "right" | "center">,
  columns: number,
): ReadonlyArray<MarkdownLine> {
  const count = Math.max(header.length, ...body.map((row) => row.length), 1);
  const cellText = (i: number): string[] => [
    normalizeCell(header[i] ?? ""),
    ...body.map((row) => normalizeCell(row[i] ?? "")),
  ].filter((cell) => cell.length > 0);
  const idealWidths: number[] = [];
  const minWidths: number[] = [];

  for (let i = 0; i < count; i += 1) {
    const cells = cellText(i);

    idealWidths.push(Math.max(...cells.map(displayWidth), MIN_COLUMN_WIDTH));
    minWidths.push(
      Math.max(
        ...cells.flatMap((cell) => cell.split(/\s+/).filter((w) => w.length > 0).map(displayWidth)),
        MIN_COLUMN_WIDTH,
      ),
    );
  }

  const borderOverhead = 1 + count * 3;
  const available = Math.max(
    columns - borderOverhead - TABLE_SAFETY_MARGIN,
    count * MIN_COLUMN_WIDTH,
  );
  const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0);
  const totalMin = minWidths.reduce((sum, w) => sum + w, 0);
  let widths: number[];

  if (totalIdeal <= available) {
    widths = idealWidths;
  } else if (totalMin <= available) {
    const extraSpace = available - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - (minWidths[i] ?? ideal));
    const totalOverflow = overflows.reduce((sum, o) => sum + o, 0);
    widths = minWidths.map((min, i) =>
      totalOverflow === 0 ? min : min + Math.floor(((overflows[i] ?? 0) / totalOverflow) * extraSpace),
    );
  } else {
    // Table wider than the terminal even at minimum widths: shrink
    // proportionally and let words break. The MIN_COLUMN_WIDTH floor is
    // deliberately dropped here — keeping it is what would overflow the
    // terminal this branch exists to fit.
    const scale = available / totalMin;
    widths = minWidths.map((min) => Math.max(Math.floor(min * scale), 1));
  }

  const rowsOf = (cells: ReadonlyArray<string>): ReadonlyArray<string> =>
    wrapRow(cells, widths, aligns);
  const lines: MarkdownLine[] = [
    ...rowsOf(widths.map((_, i) => normalizeCell(header[i] ?? ""))).map((row) => ({
      tone: "strong" as const,
      text: row,
    })),
    {
      tone: "output",
      text: `│${widths.map((w) => "─".repeat(w + 2)).join("┼")}│`,
    },
    ...body.flatMap((row) =>
      rowsOf(widths.map((_, i) => normalizeCell(row[i] ?? ""))).map((text) => ({
        tone: "assistant" as const,
        text,
      })),
    ),
  ];

  return lines;
}

/** One logical row as the display row(s) its cells wrap into. */
function wrapRow(
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  aligns: ReadonlyArray<"left" | "right" | "center">,
): ReadonlyArray<string> {
  const wrapped = cells.map((cell, i) => fitCell(cell, widths[i] ?? MIN_COLUMN_WIDTH));
  const height = Math.max(...wrapped.map((rows) => rows.length), 1);
  const lines: string[] = [];

  for (let row = 0; row < height; row += 1) {
    const parts = wrapped.map((rows, i) =>
      padCell(rows[row] ?? "", widths[i] ?? MIN_COLUMN_WIDTH, aligns[i] ?? "left"),
    );
    lines.push(`│ ${parts.join(" │ ")} │`);
  }

  return lines;
}

/** A cell's text folded into rows that each fit its column. */
function fitCell(cell: string, width: number): ReadonlyArray<string> {
  if (cell.length === 0) {
    return [""];
  }

  const parts: string[] = [];

  for (const word of cell.split("\n")) {
    let line = "";
    let lineWidth = 0;

    for (const character of word) {
      const size = displayWidth(character);
      if (lineWidth + size > width && line.length > 0) {
        parts.push(line);
        line = "";
        lineWidth = 0;
      }

      line += character;
      lineWidth += size;
    }

    parts.push(line);
  }

  return parts.length > 0 ? parts : [""];
}

function padCell(text: string, width: number, align: "left" | "right" | "center"): string {
  const gap = width - displayWidth(text);
  if (gap <= 0) {
    return text;
  }

  if (align === "right") {
    return `${" ".repeat(gap)}${text}`;
  }

  if (align === "center") {
    const left = Math.floor(gap / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(gap - left)}`;
  }

  return `${text}${" ".repeat(gap)}`;
}

/** Legacy's table cells came through `marked`, which normalises whitespace. */
function normalizeCell(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
