import type {
  PromptProjectionOutcome,
  PromptView,
} from "../ports/compaction.js";
import type { SessionRecord } from "../ports/session.js";
import { isTranscriptItem, type TranscriptItem } from "../protocol/transcript.js";
import { collectWindows } from "./window.js";

/**
 * The two views over one journal.
 *
 * `listTranscript` is what a UI, a journal dump or an auditor reads: everything
 * that was ever said, including what a summary replaced.
 * `projectForPrompt` is what the model gets: the newest summary plus whatever
 * happened after it.
 *
 * They are deliberately different results over the same bytes. The whole point
 * of compaction is "the model's past is shorter than the record's past"; a
 * projection that quietly agreed with `listTranscript` would mean the filter
 * never ran.
 *
 * Both views validate the payload of every `transcript_item` they project: the
 * byte-level checks (checksum, sequence, version) prove the journal was written
 * by a writer of this format, not that every payload still matches its type.
 * A store that has already validated its records never trips this — the guard
 * is for the paths that have not been proven, and an invalid payload reaches
 * the model's view only as a failure, never as a guessed item.
 */

export function listTranscript(records: readonly SessionRecord[]): readonly TranscriptItem[] {
  const items: TranscriptItem[] = [];

  for (const record of records) {
    if (record.type === "transcript_item") {
      // An audit view of *transcript items*: a payload that is not one is
      // classified out, not shown as a guessed item. Corruption that matters
      // already fails closed at the store's recovery boundary.
      if (isTranscriptItem(record.payload)) {
        items.push(record.payload);
      }
    }
  }

  return items;
}

/**
 * Model-visible history under an optional horizon.
 *
 * Sequence numbers are *journal* sequences, not `TranscriptItem.sequence`:
 * a window has to bound the journal, including the bookkeeping records that
 * carry no transcript item at all.
 *
 * A single unreadable window fails the whole projection. returning only the
 * live tail would look plausible and would in fact be an invented history.
 */
export function projectForPrompt(input: {
  readonly records: readonly SessionRecord[];
  readonly horizonSequence?: number;
}): PromptProjectionOutcome {
  const { records, horizonSequence } = input;
  const scanned = collectWindows(records, horizonSequence);
  if (!scanned.ok) {
    return scanned;
  }

  const windows = scanned.windows;
  const window = windows[windows.length - 1];
  const from = window === undefined ? 0 : window.replacedToSequence + 1;
  const upperBound = horizonSequence ?? Number.POSITIVE_INFINITY;

  const items: TranscriptItem[] = [];

  for (const record of records) {
    if (record.sequence < from || record.sequence > upperBound) {
      continue;
    }
    if (record.type === "transcript_item") {
      // The model's view fails closed on a foreign payload: a partial guess at
      // history is an invented past, exactly the thing a window must never be.
      if (!isTranscriptItem(record.payload)) {
        return {
          ok: false,
          code: "compact_payload_malformed",
          detail: `transcript_item payload at sequence ${record.sequence} is not a transcript item`,
        };
      }
      items.push(record.payload);
    }
  }

  // Only a validated compact window may replace recorded observations. A
  // result's size or age alone says nothing about the available context budget.
  const view: PromptView = { items, window, horizonSequence };

  return { ok: true, view };
}
