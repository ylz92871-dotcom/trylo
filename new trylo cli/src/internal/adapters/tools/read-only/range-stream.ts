import { StringDecoder } from "node:string_decoder";
import { cutToBytes } from "../../text-cut.js";
import type { ReadOnlyToolLimits } from "./limits.js";
import type { RangeRequest, RangeSelection } from "./range.js";

/** Counts the whole file without keeping skipped lines or an oversized line in memory. */
class WindowScan {
  private readonly parts: string[] = [];
  private readonly lineSizes: number[] = [];
  private retainedBytes = 0;
  private prefixClosed = false;
  private currentBytes = 0;
  private newlineCount = 0;
  private lastWasNewline = false;
  private seenText = false;
  private windowBytes = 0;
  private totalBytes = 0;

  constructor(private readonly offset: number, private readonly count: number, private readonly maxBytes: number) {}

  write(text: string): void {
    if (text.length === 0) return;
    this.seenText = true;
    this.lastWasNewline = text.endsWith("\n");
    this.totalBytes += Buffer.byteLength(text, "utf8");
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      const end = newline < 0 ? text.length : newline + 1;
      const part = text.slice(cursor, end);
      const bytes = Buffer.byteLength(part, "utf8");
      this.currentBytes += bytes;
      if (this.newlineCount >= this.offset && this.newlineCount - this.offset < this.count) {
        this.windowBytes += bytes;
        this.keep(part, bytes);
      }
      if (newline >= 0) {
        this.finishLine();
        this.newlineCount += 1;
        this.currentBytes = 0;
      }
      cursor = end;
    }
  }

  private keep(part: string, bytes: number): void {
    if (this.prefixClosed) return;
    const remaining = this.maxBytes - this.retainedBytes;
    const kept = bytes <= remaining ? part : cutToBytes(part, remaining);
    if (kept.length > 0) this.parts.push(kept);
    this.retainedBytes += Buffer.byteLength(kept, "utf8");
    // Once a code point does not fit, later ASCII cannot jump over it.
    if (bytes > remaining) this.prefixClosed = true;
  }

  private finishLine(): void {
    const relative = this.newlineCount - this.offset;
    if (relative >= 0 && relative < this.count) this.lineSizes.push(this.currentBytes);
  }

  finish(legacy: boolean): RangeSelection {
    if (this.seenText && !this.lastWasNewline) this.finishLine();
    const totalLines = this.newlineCount + (this.seenText && !this.lastWasNewline ? 1 : 0);
    const prefix = this.parts.join("");
    return legacy ? this.legacy(prefix, totalLines) : this.range(prefix, totalLines);
  }

  private range(prefix: string, totalLines: number): RangeSelection {
    if (this.offset >= totalLines) return { text: "", startLine: 0, endLine: 0, totalLines,
      nextOffset: undefined, truncated: false, truncatedLines: false, truncatedBytes: false };
    const count = Math.min(this.count, totalLines - this.offset);
    if (this.windowBytes <= this.maxBytes) {
      const next = this.offset + count;
      const more = next < totalLines;
      return { text: prefix, startLine: this.offset + 1, endLine: next, totalLines,
        nextOffset: more ? next : undefined, truncated: more, truncatedLines: more, truncatedBytes: false };
    }
    const complete = prefix.split("\n").length - 1;
    const next = this.offset + complete;
    const bytes = this.lineSizes[complete] ?? 0;
    const oversized = !prefix.endsWith("\n") && bytes > this.maxBytes;
    const text = oversized ? prefix : prefix.slice(0, prefix.lastIndexOf("\n") + 1);
    return { text, startLine: text.length === 0 ? 0 : this.offset + 1,
      endLine: text.length === 0 ? 0 : next + (oversized ? 1 : 0), totalLines,
      nextOffset: !oversized && next > this.offset ? next : undefined,
      truncated: true, truncatedLines: false, truncatedBytes: true,
      ...(oversized ? { lineTooLong: { line: next + 1, bytes } } : {}) };
  }

  private legacy(prefix: string, totalLines: number): RangeSelection {
    const pieces = prefix.split("\n");
    const truncatedLines = pieces.length > this.count;
    const text = truncatedLines ? pieces.slice(0, this.count).join("\n") : prefix;
    const truncatedBytes = this.totalBytes > this.maxBytes;
    const truncated = truncatedLines || truncatedBytes;
    const returned = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const partial = truncatedBytes && !truncatedLines && !text.endsWith("\n");
    const next = partial ? Math.max(0, returned - 1) : returned;
    const bytes = this.lineSizes[next] ?? 0;
    const tooLong = partial && bytes > this.maxBytes;
    return { text, startLine: totalLines === 0 ? 0 : 1, endLine: returned, totalLines,
      truncated, truncatedBytes, truncatedLines,
      nextOffset: truncated && !tooLong && next < totalLines ? next : undefined,
      ...(tooLong ? { lineTooLong: { line: next + 1, bytes } } : {}) };
  }
}

/** EOF is scanned for exact totalLines; retained source is bounded by the output window. */
export async function selectStreamRange(
  chunks: AsyncIterable<Uint8Array>, request: RangeRequest, limits: ReadOnlyToolLimits,
  signal: AbortSignal, legacy: boolean,
): Promise<RangeSelection> {
  const scan = new WindowScan(legacy ? 0 : request.offset,
    legacy ? limits.maxLines : Math.min(request.limit ?? limits.maxLines, limits.maxLines), limits.maxBytes);
  const decoder = new StringDecoder("utf8");
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    scan.write(decoder.write(chunk));
  }
  signal.throwIfAborted();
  scan.write(decoder.end());
  return scan.finish(legacy);
}

/** The same selection policy for injected readers that already own a complete string. */
export function selectTextRange(text: string, request: RangeRequest, limits: ReadOnlyToolLimits, legacy: boolean): RangeSelection {
  const scan = new WindowScan(legacy ? 0 : request.offset,
    legacy ? limits.maxLines : Math.min(request.limit ?? limits.maxLines, limits.maxLines), limits.maxBytes);
  scan.write(text);
  return scan.finish(legacy);
}
