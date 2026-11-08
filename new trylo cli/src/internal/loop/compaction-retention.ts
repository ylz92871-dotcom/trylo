import { SUMMARY_MAX_CHARS } from "../ports/compaction.js";
import type { SessionRecord } from "../ports/session.js";
import type { Transcript } from "../protocol/transcript.js";
import { toolCallIndexByResult } from "../protocol/tool-pairing.js";
import type { CompactionInput } from "./compact-boundary.js";
import { coveredExchangeTail } from "./prompt-view.js";
import { localViewBasis } from "./prompt-measurement.js";

/** Compact an old prefix, rather than replacing an entire ongoing task with
 * a short digest. Half the existing soft window is a retention target, not a
 * new execution limit: it leaves room for subsequent results and a summary.
 * A suffix that cannot fit falls back to the existing newest-exchange rule.
 */
export function compactionPrefixLength(input: CompactionInput): number {
  const { transcript, ledger, contextTokenLimit } = input;

  if (contextTokenLimit === undefined) return transcript.length;

  const newestExchange = coveredExchangeTail(transcript, 0);
  const newestStart = transcript.length - newestExchange.length;
  const candidates = exchangeBoundaries(transcript).filter(cut => cut > ledger.replacedPrefix && cut <= newestStart);
  const target = Math.floor(contextTokenLimit * 9 / 20);

  for (const cut of candidates) {
    const tokens = localViewBasis({ ...input, ledger: {
      ...ledger, replacedPrefix: cut,
      // Reserve the existing maximum summary size using three UTF-8 bytes per
      // code unit. This is a size bound, not an authored or stored summary.
      window: { windowId: "retention-estimate", replacedFromSequence: 0,
        replacedToSequence: 0, formatVersion: "1", summary: "\u2026".repeat(SUMMARY_MAX_CHARS) },
    } });
    if (tokens <= target) return cut;
  }

  return transcript.length;
}

/** Boundaries after a settled tool batch or before a later user/system input.
 * Track repeated call IDs positionally so no retained result loses its call.
 */
function exchangeBoundaries(items: Transcript): readonly number[] {
  const pairing = toolCallIndexByResult(items);
  const pending = new Set<number>();
  const cuts: number[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind === "tool_call") {
      pending.add(index);
    } else if (item.kind === "tool_result") {
      const call = pairing.get(index);
      if (call !== undefined) pending.delete(call);
    }

    const next = items[index + 1];
    if (pending.size === 0 && next !== undefined && next.kind !== "tool_result"
      && (item.kind === "tool_result" || next.kind === "user" || next.kind === "system")) cuts.push(index + 1);
  }

  return cuts;
}

/** The cut uses transcript positions; the port owns journal sequence bounds. */
export function prefixEndSequence(records: readonly SessionRecord[], transcript: Transcript, cut: number): number {
  const ordinal = transcript[cut - 1]?.sequence;
  const record = records.find(item => item.type === "transcript_item" && item.payload["sequence"] === ordinal);
  if (record === undefined) throw new Error("Compaction prefix has no matching journal item");
  return record.sequence;
}
