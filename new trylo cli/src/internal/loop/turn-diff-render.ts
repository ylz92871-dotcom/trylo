import type { TrackedChange } from "./turn-diff.js";

/**
 * Rendering one tracked change (WP11/C20).
 *
 * Split out of `turn-diff.ts` for the file-size discipline. Pure text
 * shaping only: pairing decisions stay in the tracker, so a rendering change
 * here can never reclassify a change.
 */

function isDiffHeaderLine(line: string): boolean {
  return (
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("@@") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file")
  );
}

export function countPreview(preview: string | undefined): { insertions: number; deletions: number } {
  if (preview === undefined) {
    return { insertions: 0, deletions: 0 };
  }

  let insertions = 0;
  let deletions = 0;

  for (const line of preview.split("\n")) {
    if (isDiffHeaderLine(line)) {
      continue;
    }
    if (line.startsWith("+")) {
      insertions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { insertions, deletions };
}

export function renderDeletion(path: string, tombstone: TrackedChange): string {
  if (tombstone.binary) {
    return `Binary files a/${path} and /dev/null differ\n`;
  }

  if (tombstone.preview !== undefined) {
    return tombstone.preview.endsWith("\n") ? tombstone.preview : `${tombstone.preview}\n`;
  }

  return `--- a/${path}\n+++ /dev/null\n... [deletion recorded without retained content; the turn checkpoint holds the bytes] ...\n`;
}

export function renderEntry(path: string, entry: TrackedChange, origin: string | undefined): string {
  if (entry.binary) {
    const left = origin === undefined ? path : origin;
    return `Binary files a/${left} and b/${path} differ\n`;
  }

  const preview = entry.preview ?? "";

  if (origin !== undefined) {
    return `rename from ${origin}\nrename to ${path}\n${preview}`;
  }

  return preview.endsWith("\n") || preview.length === 0 ? preview : `${preview}\n`;
}
