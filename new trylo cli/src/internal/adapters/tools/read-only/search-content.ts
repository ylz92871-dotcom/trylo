import type { FileSystemReader } from "./limits.js";

type SearchContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "large" }
  | { readonly kind: "binary" };

/** Stat avoids unnecessary allocation; the bounded reader also handles a file growing after stat. */
export async function readSearchContent(reader: FileSystemReader, absolute: string, maxBytes: number, signal: AbortSignal): Promise<SearchContent> {
  if (await reader.statBytes(absolute) > maxBytes) return { kind: "large" };
  signal.throwIfAborted();
  const text = reader.readFileUtf8Bounded === undefined
    ? await reader.readFileUtf8(absolute, signal)
    : await reader.readFileUtf8Bounded(absolute, maxBytes, signal);
  if (text === undefined || Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "large" };
  return text.includes("\0") ? { kind: "binary" } : { kind: "text", text };
}

/** Keep the match in view; positions remain in the original line, counted in UTF-16 units. */
export function searchSnippet(line: string, matchIndex: number): {
  readonly text: string;
  readonly textStartColumn?: number;
  readonly lineTruncated?: true;
} {
  if (line.length <= 500) return { text: line };
  let start = Math.max(0, Math.min(matchIndex - 100, line.length - 500));
  // A snippet boundary must never split an astral character into surrogate halves.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start] ?? "")) start += 1;
  let end = Math.min(line.length, start + 500);
  if (/[\uD800-\uDBFF]/.test(line[end - 1] ?? "")) end -= 1;
  return { text: line.slice(start, end), textStartColumn: start + 1, lineTruncated: true };
}
