import {
  COMPACT_WINDOW_KEYS,
  COMPACTION_FORMAT_VERSION,
  type CompactWindow,
} from "../ports/compaction.js";
import type { SessionRecord } from "../ports/session.js";

/**
 * Reading `compact` records out of the journal.
 *
 * Every journal record already survives checksums and sequence checks by the
 * time it gets here, so what remains is *shape*: a window with the wrong key
 * set or an unknown version is a record this build cannot interpret, and an
 * uninterpretable window must stop the read rather than be skipped. Skipping is
 * exactly the failure mode that undoes compaction — a skipped window silently
 * restores the history it was supposed to replace.
 */

export type WindowScanFailureCode =
  | "compact_payload_malformed"
  | "compact_format_unknown"
  | "compact_window_not_monotonic";

export type WindowScanOutcome =
  | { readonly ok: true; readonly windows: readonly CompactWindow[] }
  | { readonly ok: false; readonly code: WindowScanFailureCode; readonly detail: string };

function isWindowPayload(value: unknown): value is CompactWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const shape = value as Record<string, unknown>;
  const keys = Object.keys(shape).sort();
  const expected = [...COMPACT_WINDOW_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }

  return (
    typeof shape.windowId === "string" &&
    shape.windowId.length > 0 &&
    typeof shape.replacedFromSequence === "number" &&
    Number.isInteger(shape.replacedFromSequence) &&
    typeof shape.replacedToSequence === "number" &&
    Number.isInteger(shape.replacedToSequence) &&
    typeof shape.summary === "string" &&
    typeof shape.formatVersion === "string"
  );
}

/** A window that does not contain itself is not a window; it is corruption. */
function isInternallyConsistent(window: CompactWindow): boolean {
  return (
    window.replacedFromSequence >= 0 &&
    window.replacedToSequence >= window.replacedFromSequence &&
    window.summary.length > 0
  );
}

export type CompactWindowScan =
  | { readonly ok: true; readonly window: CompactWindow | undefined }
  | { readonly ok: false; readonly code: WindowScanFailureCode; readonly detail: string };

/** `undefined` simply means "not a compact record", which is most of them. */
export function readCompactWindow(record: SessionRecord): CompactWindowScan {
  if (record.type !== "compact") {
    return { ok: true, window: undefined };
  }

  const payload: unknown = record.payload;
  if (!isWindowPayload(payload)) {
    return {
      ok: false,
      code: "compact_payload_malformed",
      detail: `sequence ${record.sequence}`,
    };
  }

  if (payload.formatVersion !== COMPACTION_FORMAT_VERSION) {
    return {
      ok: false,
      code: "compact_format_unknown",
      detail: `sequence ${record.sequence} version ${payload.formatVersion}`,
    };
  }

  if (!isInternallyConsistent(payload)) {
    return {
      ok: false,
      code: "compact_window_not_monotonic",
      detail: `sequence ${record.sequence}`,
    };
  }

  return { ok: true, window: payload };
}

/**
 * Every compact window at or below `horizonSequence`, in journal order.
 *
 * Windows must strictly advance: each one starts after the previous one ended.
 * An overlap would mean two summaries claim the same stretch of history, which
 * reader-side heuristics would then have to adjudicate. There are none.
 */
export function collectWindows(
  records: readonly SessionRecord[],
  horizonSequence?: number,
): WindowScanOutcome {
  const windows: CompactWindow[] = [];

  for (const record of records) {
    if (horizonSequence !== undefined && record.sequence > horizonSequence) {
      break;
    }

    const scanned = readCompactWindow(record);
    if (!scanned.ok) {
      return scanned;
    }

    const window = scanned.window;
    if (window === undefined) {
      continue;
    }

    const previous = windows[windows.length - 1];
    if (previous !== undefined && window.replacedFromSequence <= previous.replacedToSequence) {
      return {
        ok: false,
        code: "compact_window_not_monotonic",
        detail: `sequence ${record.sequence} overlaps ${previous.windowId}`,
      };
    }

    if (previous !== undefined && window.replacedToSequence <= previous.replacedToSequence) {
      return {
        ok: false,
        code: "compact_window_not_monotonic",
        detail: `sequence ${record.sequence} retreats to ${window.replacedToSequence}`,
      };
    }

    windows.push(window);
  }

  return { ok: true, windows };
}
