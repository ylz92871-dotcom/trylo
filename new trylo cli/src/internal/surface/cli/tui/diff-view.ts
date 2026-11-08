import type { TuiLine, TuiTone } from "./state.js";
import { foldToolOutput, MAX_OUTPUT_LINE_CHARS, MAX_TOOL_OUTPUT_LINES } from "../tool-output.js";

/**
 * A unified diff inside tool output, rendered as the rows a person reads
 * (WP23.1 / L43).
 *
 * Tools that change files answer with unified diffs, and the line-level
 * heuristic (`toneOfDiffRow`) coloured the changes but dropped the one thing a
 * diff is for: where in the file each row sits. This renderer reads the hunk
 * headers, keeps its own old/new row counters, and puts the number in a gutter
 * the way every diff viewer does.
 *
 * It declines anything that is not a diff — one hunk header plus at least one
 * changed row is the minimum evidence — and the caller falls back to the
 * heuristic, so ordinary output that merely starts with `-` is untouched.
 */

/** A parsed hunk header is all this module needs from `@@ -a,b +c,d @@`. */

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function diffLines(output: string): ReadonlyArray<TuiLine> | undefined {
  const rows = output.replace(/\r\n/g, "\n").split("\n");
  const hasHunk = rows.some((row) => HUNK.test(row));
  if (!hasHunk) {
    return undefined;
  }

  const changed = rows.some((row) => /^(\+|-)/.test(row));
  if (!changed) {
    return undefined;
  }

  const lines: TuiLine[] = [];
  let oldRow = 0;
  let newRow = 0;

  for (const row of rows) {
    const hunk = HUNK.exec(row);
    if (hunk !== null) {
      oldRow = Number(hunk[1]);
      newRow = Number(hunk[2]);
      lines.push({ tone: "tool", text: row });
      continue;
    }

    if (/^(\+\+\+|---) /.test(row)) {
      lines.push({ tone: "output", text: row });
      continue;
    }

    if (row.startsWith("+")) {
      lines.push(gutter("added", newRow, row.slice(1)));
      newRow += 1;
      continue;
    }

    if (row.startsWith("-")) {
      lines.push(gutter("removed", oldRow, row.slice(1)));
      oldRow += 1;
      continue;
    }

    if (row.startsWith(" ")) {
      lines.push(gutter("output", newRow, row.slice(1)));
      newRow += 1;
      oldRow += 1;
      continue;
    }

    lines.push({ tone: "output", text: row });
  }

  return lines;
}

/**
 * The gutter is as wide as the largest row number this diff can show, so every
 * number ends on the same column and the signs align — the property that makes
 * a diff scannable.
 */
function gutter(tone: TuiTone, row: number, text: string): TuiLine {
  return { tone, text: `${String(row).padStart(GUTTER_WIDTH)} ${text}` };
}

const GUTTER_WIDTH = 4;

// --- Quoted tool output -----------------------------------------------------

/**
 * A tool's own text as the lines a person sees, indented under its call.
 *
 * A unified diff takes the gutter path; everything else keeps the line-level
 * `+`/`-` heuristic, which needs no protocol change — a tool that prints a
 * diff already has the signs at the start of its rows.
 */
export function quotedOutput(output: string): ReadonlyArray<TuiLine> {
  const diff = diffLines(output);
  if (diff !== undefined) {
    return foldDiff(diff);
  }
  return foldToolOutput(output).map((row) => lineTone(toneOfDiffRow(row), `   ${row}`));
}

/**
 * The diff path folds by the same policy as `foldToolOutput` — the same line
 * count, the same row clamp, the same tail — but keeps each row's tone, which
 * a fold over raw text cannot do.
 */
function foldDiff(diff: ReadonlyArray<TuiLine>): ReadonlyArray<TuiLine> {
  const shown = diff.slice(0, MAX_TOOL_OUTPUT_LINES).map((line) => ({
    ...line,
    text: `   ${line.text.length <= MAX_OUTPUT_LINE_CHARS ? line.text : `${line.text.slice(0, MAX_OUTPUT_LINE_CHARS - 1)}…`}`,
  }));
  const hidden = diff.length - shown.length;

  return hidden > 0
    ? [...shown, lineTone("output", `   ... ${hidden} more lines`)]
    : shown;
}


/**
 * Whether a quoted row is half of a diff, judged from the row itself.
 *
 * No protocol change is needed for a coloured diff: a tool that prints a
 * unified diff already has `+`/`-` at the start of its rows, and the surface
 * only has to notice. The `+++`/`---` file headers are excluded — they are
 * navigation, not content, and painting them the colour of the change they
 * introduce makes a header look like a whole file was added.
 *
 * A bare `+` or `-` in ordinary output would be misread as a diff, so the row
 * has to look like one: the sign followed by something.
 */
export function toneOfDiffRow(row: string): TuiTone {
  if (/^\+\+\+/.test(row) || /^---/.test(row)) {
    return "output";
  }

  // The sign must be followed by something that is not a space: a unified
  // diff row is `-old line`, while a markdown bullet is `- item`. Without
  // this, every bulleted list a tool printed came out red.
  if (/^\+\S/.test(row)) {
    return "added";
  }

  if (/^-\S/.test(row)) {
    return "removed";
  }

  return "output";
}

function lineTone(tone: TuiTone, text: string): TuiLine {
  return { tone, text };
}
