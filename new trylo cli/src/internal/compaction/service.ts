import {
  COMPACTION_FORMAT_VERSION,
  type CompactOutcome,
  type CompactRequest,
  type CompactWindow,
  type CompactionPort,
  type RollbackOutcome,
} from "../ports/compaction.js";
import type { SessionRecord } from "../ports/session.js";
import { shouldCompact } from "./policy.js";
import { projectForPrompt } from "./projection.js";
import { collectWindows } from "./window.js";
import { validateSummary } from "./summary.js";

/**
 * Composition point for the compaction behaviours. It owns no state and
 * touches no storage: `compact` returns a draft for the session store to append,
 * which keeps one writer for the journal. The rollback horizon is handed back to
 * the caller to carry forward, so nothing here remembers anything between calls.
 *
 * The read-time view comes from `projection.ts`: only a validated window may
 * replace a recorded prefix; tool observations in its live suffix stay intact.
 */

export function createCompactionService(): CompactionPort {
  return {
    shouldCompact,
    projectForPrompt,
    compact,
    rollbackTranscript,
  };
}

function compact(request: CompactRequest): CompactOutcome {
  if (request.replacedToSequence !== undefined
    && (!Number.isInteger(request.replacedToSequence) || request.replacedToSequence < 0)) {
    return { ok: false, code: "compact_window_not_monotonic", detail: "invalid replaced prefix boundary" };
  }

  const scanned = collectWindows(request.records, request.horizonSequence);
  if (!scanned.ok) {
    return scanned;
  }

  const windows = scanned.windows;
  const previous = windows[windows.length - 1];
  const bounds = liveTranscriptBounds(request.records, previous,
    request.replacedToSequence === undefined ? request.horizonSequence
      : Math.min(request.replacedToSequence, request.horizonSequence ?? Number.POSITIVE_INFINITY));
  if (bounds === undefined) {
    return { ok: false, code: "nothing_to_compact", detail: "no live transcript items" };
  }

  const replacedFromSequence = previous === undefined ? 0 : previous.replacedToSequence + 1;
  if (bounds.last < replacedFromSequence) {
    return {
      ok: false,
      code: "compact_window_not_monotonic",
      detail: `${bounds.last} < ${replacedFromSequence}`,
    };
  }

  const validated = validateSummary(request.summary);
  if (!validated.ok) {
    return validated;
  }

  const window: CompactWindow = {
    windowId: nextWindowId(windows),
    replacedFromSequence,
    replacedToSequence: bounds.last,
    summary: request.summary,
    formatVersion: COMPACTION_FORMAT_VERSION,
  };

  return {
    ok: true,
    record: { type: "compact", sessionId: request.sessionId, at: request.at, payload: window },
  };
}

/** A resumed decision view may retain only its last window, not its count.
 * Opaque historical IDs stay readable; without a numeric ID retain the old
 * count-based starting point. BigInt keeps string ordinals exact past 2^53. */
function nextWindowId(windows: readonly CompactWindow[]): string {
  let highest = 0n;

  for (const window of windows) {
    if (!/^w[1-9]\d*$/.test(window.windowId)) continue;
    const ordinal = BigInt(window.windowId.slice(1));
    if (ordinal > highest) highest = ordinal;
  }

  return `w${(highest === 0n ? BigInt(windows.length) : highest) + 1n}`;
}

function liveTranscriptBounds(
  records: readonly SessionRecord[],
  previous: CompactWindow | undefined,
  horizonSequence: number | undefined,
): { readonly first: number; readonly last: number } | undefined {
  const from = previous === undefined ? 0 : previous.replacedToSequence + 1;
  const upperBound = horizonSequence ?? Number.POSITIVE_INFINITY;
  let first: number | undefined;
  let last: number | undefined;

  for (const record of records) {
    if (record.sequence < from || record.sequence > upperBound) {
      continue;
    }

    if (record.type !== "transcript_item") {
      continue;
    }

    if (first === undefined) {
      first = record.sequence;
    }

    last = record.sequence;
  }

  return first === undefined || last === undefined ? undefined : { first, last };
}

function rollbackTranscript(input: {
  readonly records: readonly SessionRecord[];
  readonly sequence: number;
}): RollbackOutcome {
  const last = input.records[input.records.length - 1];
  const highest = last?.sequence ?? -1;
  if (!Number.isInteger(input.sequence) || input.sequence < 0 || highest < 0) {
    return { ok: false, code: "sequence_unknown", detail: `${input.sequence}` };
  }

  if (input.sequence >= highest) {
    return { ok: false, code: "nothing_to_roll_back", detail: `${input.sequence} >= ${highest}` };
  }

  return { ok: true, horizonSequence: input.sequence };
}
