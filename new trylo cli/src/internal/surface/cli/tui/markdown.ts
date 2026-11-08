import type { TuiTone } from "./state.js";
import { isTableAt, tableBlock } from "./markdown-table.js";

/**
 * The markdown block renderer (WP23.1 / L43).
 *
 * A model's answer is markdown, and the frame's one-line-per-tone renderer
 * turned a table into a row of pipes and a heading into a line of hashes. This
 * module turns the answer into the lines a person reads: headings become bold
 * rows, lists keep their markers, code is quoted, and tables are laid out on
 * real terminal columns.
 *
 * What it deliberately is not: a markdown *library*. The answers this renders
 * are LLM answers, whose markdown is a small regular dialect — headings, lists,
 * fenced code, quotes, rules, tables, inline emphasis. The parser below is that
 * dialect and no more, so the build takes no runtime dependency for it and the
 * table layout can share the frame's own width table (`displayWidth`) instead
 * of importing a second, possibly disagreeing one. Anything it does not
 * recognise is passed through as the plain text it would have been before this
 * module existed, so a construct it mis-read degrades to today's rendering
 * rather than to noise.
 *
 * Inline emphasis is stripped, not styled: the frame paints one tone per line,
 * and a bold run inside an otherwise plain line would need per-segment
 * sequences that wrap measurement (the invariant `frame.ts` holds) is not built
 * to track. Stripping keeps the words; losing the weight on one word is the
 * smaller wrong.
 */

/** One rendered row: the same shape the frame state stores. */
export type MarkdownLine = {
  readonly tone: TuiTone;
  readonly text: string;
};

const BLOCKQUOTE_MARK = "▌ ";

export function markdownLines(text: string, columns: number): ReadonlyArray<MarkdownLine> {
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  const out: MarkdownLine[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index] ?? "";
    const fence = fenceOf(row);
    if (fence !== undefined) {
      index = fenceBlock(rows, index, fence, out);
      continue;
    }

    const heading = headingOf(row);
    if (heading !== undefined) {
      out.push({ tone: "strong", text: stripInline(heading) });
      index += 1;
      continue;
    }

    if (isRule(row)) {
      out.push({ tone: "output", text: "───" });
      index += 1;
      continue;
    }

    if (isTableAt(rows, index)) {
      index = tableBlock(rows, index, columns, out);
      continue;
    }

    const quote = quoteOf(row);
    if (quote !== undefined) {
      index = quoteBlock(rows, index, out);
      continue;
    }

    const item = listItemOf(row);
    if (item !== undefined) {
      index = listBlock(rows, index, out);
      continue;
    }

    if (row.trim().length === 0) {
      out.push({ tone: "assistant", text: "" });
      index += 1;
      continue;
    }

    out.push({ tone: "assistant", text: stripInline(row) });
    index += 1;
  }

  return out.length === 0 ? [{ tone: "assistant", text: "" }] : out;
}

/** A fenced code block opens with ``` or ~~~ (up to three spaces of indent). */
function fenceOf(row: string): string | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(row);
  return match?.[1];
}

/** Consume a fenced block: the fence rows and body quote as output, verbatim. */
function fenceBlock(
  rows: ReadonlyArray<string>,
  start: number,
  opening: string,
  out: MarkdownLine[],
): number {
  const fenceCharacter = opening[0] ?? "`";

  out.push({ tone: "output", text: (rows[start] ?? "").trim() });
  let index = start + 1;

  while (index < rows.length) {
    const row = rows[index] ?? "";
    const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(row);
    if (closing !== null && (closing[1] ?? "")[0] === fenceCharacter) {
      out.push({ tone: "output", text: row.trim() });
      return index + 1;
    }

    out.push({ tone: "output", text: row });
    index += 1;
  }

  // Unterminated fence: the body was consumed as code, which is what the
  // person typing it saw too — an unclosed fence renders as code to the end.
  return index;
}

function headingOf(row: string): string | undefined {
  const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(row);
  return match?.[1];
}

function isRule(row: string): boolean {
  return /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(row);
}

function quoteOf(row: string): string | undefined {
  const match = /^ {0,3}>\s?(.*)$/.exec(row);
  return match?.[1];
}

/** One blockquote's rows, joined with the marker carried in the text. */
function quoteBlock(rows: ReadonlyArray<string>, start: number, out: MarkdownLine[]): number {
  let index = start;

  while (index < rows.length) {
    const quote = quoteOf(rows[index] ?? "");
    if (quote === undefined) {
      break;
    }
    out.push({ tone: "quote", text: `${BLOCKQUOTE_MARK}${stripInline(quote)}` });
    index += 1;
  }

  return index;
}

type ListItem = { readonly indent: number; readonly marker: string; readonly text: string };

function listItemOf(row: string): ListItem | undefined {
  const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(row);
  if (match === null) {
    return undefined;
  }

  const [, spaces, marker, body] = match;

  return {
    indent: Math.floor(((spaces ?? "").length) / 2),
    marker: /^\d/.test(marker ?? "") ? `${parseInt(marker ?? "1", 10)}.` : "-",
    text: stripInline(body ?? ""),
  };
}

/** A list run: items and the continuation rows that belong to the last one. */
function listBlock(rows: ReadonlyArray<string>, start: number, out: MarkdownLine[]): number {
  let index = start;

  while (index < rows.length) {
    const item = listItemOf(rows[index] ?? "");
    if (item !== undefined) {
      const pad = "  ".repeat(item.indent);
      out.push({ tone: "assistant", text: `${pad}${item.marker} ${item.text}` });
      index += 1;
      continue;
    }

    // An indented row under an item continues it (a wrapped sentence or a
    // sub-paragraph); the text keeps its own indentation minus one level.
    const row = rows[index] ?? "";
    const continuation = /^ {2,}\S/.test(row) && row.trim().length > 0;
    if (continuation && index > start) {
      out.push({ tone: "assistant", text: `  ${stripInline(row.trim())}` });
      index += 1;
      continue;
    }

    break;
  }

  return index;
}

/** Inline emphasis and code markers come off; the words stay. */
function stripInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}
