import type { AppliedOp, AppliedRegion } from "./apply-patch-match.js";

/**
 * Unified-diff previews for L15, rendered from the operations that applied.
 *
 * Rendering from ops rather than re-diffing `before`/`after` is the point:
 * a re-diff could disagree with what landed (different algorithm, different
 * context), while ops *are* what landed. Line splitting normalises CRLF to
 * LF for display only; the bytes on disk are untouched by this module.
 */

export type PreviewInput =
  | { readonly kind: "added"; readonly path: string; readonly before: string; readonly after: string; readonly regions: ReadonlyArray<AppliedRegion> }
  | { readonly kind: "deleted"; readonly path: string; readonly before: string; readonly after: string; readonly regions: ReadonlyArray<AppliedRegion> }
  | { readonly kind: "updated"; readonly path: string; readonly before: string; readonly after: string; readonly regions: ReadonlyArray<AppliedRegion> }
  | { readonly kind: "moved"; readonly path: string; readonly from: string; readonly before: string; readonly after: string; readonly regions: ReadonlyArray<AppliedRegion> };

const CONTEXT_RADIUS = 3;
/** Model-output bounding: a preview is a summary, not a second copy of the file. */
const MAX_PREVIEW_LINES = 120;

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  return content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function oldSpanOf(region: AppliedRegion): number {
  return region.ops.filter((op) => op.kind !== "added").length;
}

function newSpanOf(region: AppliedRegion): number {
  return region.ops.filter((op) => op.kind !== "removed").length;
}

function headerOf(input: PreviewInput): string[] {
  if (input.kind === "added") {
    return ["--- /dev/null", `+++ b/${input.path}`];
  }

  if (input.kind === "deleted") {
    return [`--- a/${input.path}`, "+++ /dev/null"];
  }

  if (input.kind === "moved") {
    return [`--- a/${input.from}`, `+++ b/${input.path}`];
  }

  return [`--- a/${input.path}`, `+++ b/${input.path}`];
}

/** Whole-file changes carry no regions; their ops are the file itself. */
function regionsOf(input: PreviewInput): AppliedRegion[] {
  if (input.regions.length > 0) {
    return input.regions.map((region) => ({ ...region, ops: [...region.ops] }));
  }

  if (input.kind === "added") {
    return [
      {
        oldStart: 0,
        newStart: 0,
        ops: splitLines(input.after).map((text) => ({ kind: "added", text }) as const),
      },
    ];
  }

  if (input.kind === "deleted") {
    return [
      {
        oldStart: 0,
        newStart: 0,
        ops: splitLines(input.before).map((text) => ({ kind: "removed", text }) as const),
      },
    ];
  }

  return [];
}

/** Regions whose context windows touch render as one hunk section. */
function mergeNearby(regions: ReadonlyArray<AppliedRegion>): AppliedRegion[][] {
  const sorted = [...regions].sort((left, right) => left.oldStart - right.oldStart);
  const groups: AppliedRegion[][] = [];

  for (const region of sorted) {
    const tail = groups[groups.length - 1];
    const last = tail?.[tail.length - 1];
    if (tail === undefined || last === undefined) {
      groups.push([region]);
      continue;
    }

    if (region.oldStart - (last.oldStart + oldSpanOf(last)) > CONTEXT_RADIUS * 2) {
      groups.push([region]);
      continue;
    }

    tail.push(region);
  }

  return groups;
}

type Section = {
  readonly oldStart: number;
  readonly newStart: number;
  readonly ops: ReadonlyArray<AppliedOp>;
};

/**
 * Joins one group into a single op stream, filling the gaps between regions
 * with context ops taken from the real before-content. The gaps are
 * unchanged lines by construction (regions never overlap), so later
 * coordinates stay derivable by walking: only the first region's `newStart`
 * is kept, the rest follows from the op stream itself.
 */
function buildSection(group: ReadonlyArray<AppliedRegion>, oldLines: ReadonlyArray<string>): Section {
  const first = group[0];
  if (first === undefined) {
    return { oldStart: 0, newStart: 0, ops: [] };
  }

  const ops: AppliedOp[] = [];
  let cursor = first.oldStart;

  for (const region of group) {
    for (const text of oldLines.slice(cursor, region.oldStart)) {
      ops.push({ kind: "context", text });
    }
    ops.push(...region.ops);
    cursor = region.oldStart + oldSpanOf(region);
  }

  return { oldStart: first.oldStart, newStart: first.newStart, ops };
}

/**
 * Renders the full preview. File context outside each section comes from the
 * real before-content at the coordinates the matcher reported; context
 * between merged regions is filled from the same source, so every hunk
 * header always agrees with the body lines that follow it.
 */
export function renderPreview(input: PreviewInput): string {
  const oldLines = splitLines(input.before);
  const out: string[] = headerOf(input);

  for (const group of mergeNearby(regionsOf(input))) {
    const section = buildSection(group, oldLines);
    const windowStart = Math.max(0, section.oldStart - CONTEXT_RADIUS);
    const windowEnd = section.oldStart + oldSpanOf(section) + CONTEXT_RADIUS;
    const leading = oldLines.slice(windowStart, section.oldStart).map((text) => ` ${text}`);
    const trailing = oldLines.slice(section.oldStart + oldSpanOf(section), windowEnd).map((text) => ` ${text}`);
    const body = section.ops.map((op) => `${op.kind === "context" ? " " : op.kind === "removed" ? "-" : "+"}${op.text}`);
    const oldCount = oldSpanOf(section) + leading.length + trailing.length;
    const newCount = newSpanOf(section) + leading.length + trailing.length;
    const newWindowStart = section.newStart - (section.oldStart - windowStart);

    out.push(`@@ -${windowStart + 1},${oldCount} +${newWindowStart + 1},${newCount} @@`);
    out.push(...leading, ...body, ...trailing);
  }

  if (out.length <= MAX_PREVIEW_LINES) {
    return `${out.join("\n")}\n`;
  }

  const kept = out.slice(0, MAX_PREVIEW_LINES);

  return `${kept.join("\n")}\n... [preview truncated: ${out.length - MAX_PREVIEW_LINES} more lines] ...\n`;
}
