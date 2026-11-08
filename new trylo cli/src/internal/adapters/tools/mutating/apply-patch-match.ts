import { prepareSource, type PreparedSource } from "./patch-engine.js";
import type { ApplyPatchUpdateChunk } from "./apply-patch-format.js";

/**
 * Tolerant chunk matching and replacement, ported from Codex
 * `seek_sequence.rs` (four-pass locate: exact, trailing-trimmed,
 * fully-trimmed, unicode-normalised) and `file_update.rs`
 * (`compute_replacements` in `PreserveLineEndings` mode).
 *
 * Two deliberate divergences from the Codex default, both following the
 * conventions this package already chose for `edit_file`:
 *
 * - line endings are always preserved per line (untouched lines keep their
 *   own terminators, inserted lines take the file's majority style), i.e.
 *   the Codex `PreserveLineEndings` mode rather than its `NormalizeToLf`
 *   default;
 * - no trailing newline is forced: a file that ended without one still does
 *   afterwards, exactly like `patch-engine.ts`.
 */

export type AppliedOp =
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string }
  | { readonly kind: "added"; readonly text: string };

export type AppliedRegion = {
  /**
   * 0-based line index in the original file where the chunk landed.
   *
   * Valid only inside the `before` coordinate system of the
   * `applyUpdateChunks` call that produced it: regions from different calls
   * must never be concatenated without re-anchoring (the preview renderer
   * fills gaps from that call's own before-content for exactly this reason).
   */
  readonly oldStart: number;
  /** 0-based line index in the new file where the chunk landed. */
  readonly newStart: number;
  readonly ops: ReadonlyArray<AppliedOp>;
};

export type ChunkApplyResult =
  | { readonly ok: true; readonly content: string; readonly regions: ReadonlyArray<AppliedRegion> }
  | { readonly ok: false; readonly code: "patch_hunk_mismatch"; readonly message: string };

type Replacement = {
  readonly start: number;
  readonly oldLen: number;
  readonly newLines: ReadonlyArray<string>;
};

function normaliseLine(value: string): string {
  return value
    .trim()
    .replaceAll(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replaceAll(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replaceAll(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replaceAll(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, " ");
}

function passMatches(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, at: number, pass: number): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    const line = lines[at + offset] ?? "";
    const wanted = pattern[offset] ?? "";
    if (pass === 0 && line !== wanted) {
      return false;
    }

    if (pass === 1 && line.trimEnd() !== wanted.trimEnd()) {
      return false;
    }

    if (pass === 2 && line.trim() !== wanted.trim()) {
      return false;
    }

    if (pass === 3 && normaliseLine(line) !== normaliseLine(wanted)) {
      return false;
    }
  }
  return true;
}

/**
 * Locates `pattern` at or after `start`, most-strict pass first. An
 * end-of-file chunk prefers the tail, exactly like the Codex `eof` flag.
 */
export function seekSequence(
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) {
    return start;
  }

  if (pattern.length > lines.length) {
    return undefined;
  }

  const searchStart = eof ? Math.max(lines.length - pattern.length, start) : start;

  for (let pass = 0; pass < 4; pass += 1) {
    for (let at = searchStart; at + pattern.length <= lines.length; at += 1) {
      if (passMatches(lines, pattern, at, pass)) {
        return at;
      }
    }
  }

  return undefined;
}

function expandChunk(chunk: ApplyPatchUpdateChunk): ReadonlyArray<AppliedOp> {
  const ops: AppliedOp[] = [];
  const pairs = chunk.contextPairs;
  let oldIndex = 0;
  let newIndex = 0;

  for (const pair of pairs) {
    const [contextOld, contextNew] = pair;

    while (oldIndex < contextOld) {
      ops.push({ kind: "removed", text: chunk.oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    }

    while (newIndex < contextNew) {
      ops.push({ kind: "added", text: chunk.newLines[newIndex] ?? "" });
      newIndex += 1;
    }

    ops.push({ kind: "context", text: chunk.oldLines[oldIndex] ?? "" });
    oldIndex += 1;
    newIndex += 1;
  }

  while (oldIndex < chunk.oldLines.length) {
    ops.push({ kind: "removed", text: chunk.oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }

  while (newIndex < chunk.newLines.length) {
    ops.push({ kind: "added", text: chunk.newLines[newIndex] ?? "" });
    newIndex += 1;
  }

  return ops;
}

function replacementsOf(
  start: number,
  oldCount: number,
  newLines: ReadonlyArray<string>,
  pairs: ReadonlyArray<readonly [number, number]>,
): Replacement[] {
  const out: Replacement[] = [];
  let oldFrom = 0;
  let newFrom = 0;

  for (const pair of pairs) {
    const [contextOld, contextNew] = pair;

    if (contextOld >= oldCount || contextNew >= newLines.length) {
      break;
    }

    if (oldFrom !== contextOld || newFrom !== contextNew) {
      out.push({ start: start + oldFrom, oldLen: contextOld - oldFrom, newLines: newLines.slice(newFrom, contextNew) });
    }

    oldFrom = contextOld + 1;
    newFrom = contextNew + 1;
  }

  if (oldFrom !== oldCount || newFrom !== newLines.length) {
    out.push({ start: start + oldFrom, oldLen: oldCount - oldFrom, newLines: newLines.slice(newFrom) });
  }

  return out;
}

export { prepareSource };
export type { PreparedSource };

/**
 * Applies update chunks to a prepared source. Either every chunk lands and
 * the full new content is returned, or nothing is returned at all: there is
 * no half-applied middle, mirroring `edit_file`.
 */
export function applyUpdateChunks(
  source: PreparedSource,
  chunks: ReadonlyArray<ApplyPatchUpdateChunk>,
  path: string,
): ChunkApplyResult {
  const replacements: Replacement[] = [];
  const located: Array<{ at: number; ops: ReadonlyArray<AppliedOp> }> = [];
  let cursor = 0;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (chunk === undefined) {
      continue;
    }

    if (chunk.changeContext !== undefined) {
      const anchored = seekSequence(source.lines, [chunk.changeContext], cursor, false);
      if (anchored === undefined) {
        return {
          ok: false,
          code: "patch_hunk_mismatch",
          message: `patch_hunk_mismatch: chunk ${chunkIndex} failed to find context '${chunk.changeContext}' in ${path}`,
        };
      }

      cursor = anchored + 1;
    }

    if (chunk.oldLines.length === 0) {
      located.push({ at: source.lines.length, ops: expandChunk(chunk) });
      replacements.push({ start: source.lines.length, oldLen: 0, newLines: [...chunk.newLines] });
      continue;
    }

    let pattern: ReadonlyArray<string> = chunk.oldLines;
    let fresh: ReadonlyArray<string> = chunk.newLines;
    let at = seekSequence(source.lines, pattern, cursor, chunk.endOfFile);
    if (at === undefined && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      fresh = fresh.length > 0 && fresh[fresh.length - 1] === "" ? fresh.slice(0, -1) : fresh;
      at = seekSequence(source.lines, pattern, cursor, chunk.endOfFile);
    }

    if (at === undefined) {
      const wanted = chunk.oldLines[0] ?? "";
      return {
        ok: false,
        code: "patch_hunk_mismatch",
        message: `patch_hunk_mismatch: chunk ${chunkIndex} expected ${JSON.stringify(wanted.slice(0, 100))} in ${path}. Copy exact text and keep one diff-space plus original indentation on context lines.`,
      };
    }

    if (at < cursor) {
      return {
        ok: false,
        code: "patch_hunk_mismatch",
        message: `patch_hunk_mismatch: chunk ${chunkIndex} overlaps the previous chunk in ${path}`,
      };
    }

    for (const replacement of replacementsOf(at, pattern.length, fresh, chunk.contextPairs)) {
      replacements.push(replacement);
    }

    located.push({ at, ops: expandChunk(chunk) });
    cursor = at + pattern.length;
  }

  replacements.sort((left, right) => left.start - right.start);
  const woven = weave(source, replacements);
  if (!woven.ok) {
    return woven;
  }

  return { ok: true, content: woven.content, regions: locateRegions(replacements, located) };
}

/**
 * Maps each chunk to its new-file coordinates. Earlier replacements shift
 * later chunks; a replacement starting before a chunk's landing ends at or
 * before it (chunks never overlap), so only strictly-earlier replacements
 * contribute to the shift.
 */
function locateRegions(
  replacements: ReadonlyArray<Replacement>,
  located: ReadonlyArray<{ at: number; ops: ReadonlyArray<AppliedOp> }>,
): ReadonlyArray<AppliedRegion> {
  return located.map((entry) => {
    let shift = 0;

    for (const replacement of replacements) {
      if (replacement.start < entry.at) {
        shift += replacement.newLines.length - replacement.oldLen;
      }
    }

    return { oldStart: entry.at, newStart: entry.at + shift, ops: entry.ops };
  });
}

function weave(
  source: PreparedSource,
  replacements: ReadonlyArray<Replacement>,
): { readonly ok: true; readonly content: string } | { readonly ok: false; readonly code: "patch_hunk_mismatch"; readonly message: string } {
  const crlf = source.endings.filter((ending) => ending === "\r\n").length;
  const lf = source.endings.filter((ending) => ending === "\n").length;
  const style: "\r\n" | "\n" = crlf > lf ? "\r\n" : "\n";
  const out: Array<{ text: string; ending: string }> = [];
  let cursor = 0;

  for (const replacement of replacements) {
    if (replacement.start < cursor) {
      return {
        ok: false,
        code: "patch_hunk_mismatch",
        message: "patch_hunk_mismatch: replacements overlap; refusing rather than interleaving",
      };
    }

    for (let index = cursor; index < replacement.start; index += 1) {
      out.push({ text: source.lines[index] ?? "", ending: source.endings[index] ?? "\n" });
    }

    const freed: string[] = [];

    for (let index = replacement.start; index < replacement.start + replacement.oldLen; index += 1) {
      freed.push(source.endings[index] ?? style);
    }

    for (const text of replacement.newLines) {
      out.push({ text, ending: freed.shift() ?? style });
    }

    cursor = replacement.start + replacement.oldLen;
  }

  for (let index = cursor; index < source.lines.length; index += 1) {
    out.push({ text: source.lines[index] ?? "", ending: source.endings[index] ?? "\n" });
  }

  return { ok: true, content: out.map((line) => `${line.text}${line.ending}`).join("") };
}
