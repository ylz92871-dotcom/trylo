import { readFileSync } from "node:fs";

import type { WatchId, WatchRow, WatchTrigger } from "../../ports/watch.js";

/**
 * Reading and validating the watch rows in the shared schedule record
 * (WP26 / A07).
 *
 * ## Why this is separate from the store
 *
 * Deciding what a row *means* and deciding what the store *does about it* are
 * different questions, and mixing them is how a file format starts leaking into
 * behaviour. Everything here is a pure function of bytes on disk: a hand-edited,
 * truncated or half-written row has to become "not a watch" rather than a watch
 * with `undefined` in a field that is later read as a timestamp.
 *
 * ## What "not a watch" means here
 *
 * `undefined` — the row is skipped. Not a default-filled watch, not a thrown
 * error. A record shared with cron schedules may legitimately contain rows this
 * version does not understand, and one of them must not stop the others from
 * being listed.
 */

/** One row of the record's `schedules` array, still untrusted. */
export type StoredRow = Readonly<Record<string, unknown>>;

/**
 * Every row in the record, whatever kind.
 *
 * An absent or unreadable file reads as empty. That is the honest answer for a
 * store nobody has written to yet; a *corrupt* file is reported by the store's
 * `list` refusing, so "no watches" is never guessed at.
 */
export function readRows(file: string): ReadonlyArray<StoredRow> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }
    const rows = (parsed as Record<string, unknown>)["schedules"];
    return Array.isArray(rows) ? (rows as ReadonlyArray<StoredRow>) : [];
  } catch {
    return [];
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A trigger, or `undefined`.
 *
 * A condition's inner shape is **not** re-validated here. It was validated when
 * it was written, and re-deriving that requires the condition vocabulary — which
 * belongs to `domain/watch.ts` and would make this file a second place that has
 * to know about it. What is checked is that it is an object, which is what stops
 * a `null` from reaching code that will read a field off it.
 */
function decodeTrigger(value: unknown): WatchTrigger | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record["kind"] === "deadline") {
    return typeof record["atMs"] === "number" ? { kind: "deadline", atMs: record["atMs"] } : undefined;
  }

  if (record["kind"] === "condition" && typeof record["condition"] === "object" && record["condition"] !== null) {
    return { kind: "condition", condition: record["condition"] } as WatchTrigger;
  }

  return undefined;
}

/**
 * Decode one watch row, or `undefined` when it is not a usable watch.
 *
 * The stored state is a **word**; the domain's is a **union**. Converting here,
 * rather than asserting, is what keeps a hand-edited `"state": "done"` from
 * becoming a watch whose state claims something the state machine has no name for.
 */
export function decodeWatch(row: StoredRow): WatchRow | undefined {
  if (row["kind"] !== "watch") {
    return undefined;
  }

  const id = row["watchId"];
  const text = row["text"];
  const sessionId = row["sessionId"];
  const createdAtMs = row["createdAtMs"];
  const trigger = decodeTrigger(row["trigger"]);

  if (typeof id !== "string" || id.length === 0) {
    return undefined;
  }

  if (typeof text !== "string" || typeof sessionId !== "string") {
    return undefined;
  }

  if (typeof createdAtMs !== "number" || trigger === undefined) {
    return undefined;
  }

  return {
    id,
    trigger,
    state: decodeState(row, id, trigger, createdAtMs),
    text,
    sessionId,
    createdAtMs,
    ...(typeof row["firedBecause"] === "string" ? { firedBecause: row["firedBecause"] } : {}),
  };
}

function decodeState(
  row: StoredRow,
  id: WatchId,
  trigger: WatchTrigger,
  createdAtMs: number,
): WatchRow["state"] {
  const state = row["state"];
  if (state === "fired") {
    return {
      state: "fired",
      watchId: id,
      firedAtMs: numberOr(row["firedAtMs"], createdAtMs),
      messageId: typeof row["messageId"] === "string" ? row["messageId"] : id,
    };
  }

  if (state === "cancelled") {
    return {
      state: "cancelled",
      watchId: id,
      cancelledAtMs: numberOr(row["cancelledAtMs"], createdAtMs),
      reason: typeof row["reason"] === "string" ? row["reason"] : "cancelled",
    };
  }

  // Anything else is armed: the state a watch is in for as long as it is waiting,
  // and the only state in which cancelling is meaningful.
  const armedAtMs = numberOr(row["armedAtMs"], createdAtMs);

  return {
    state: "armed",
    watchId: id,
    fireAtMs: trigger.kind === "deadline" ? trigger.atMs : armedAtMs,
  };
}

/**
 * Encode a watch row.
 *
 * The occurrence that proves the fire is **not** written here. It lives in the
 * record's `occurrences` array under a derived id, and keeping it out of the row
 * is what lets a restart tell "armed, but it already fired" from "armed and
 * waiting" by looking at one place instead of trusting a word in a row.
 */
export function encodeWatch(row: WatchRow): StoredRow {
  const base = {
    kind: "watch",
    watchId: row.id,
    trigger: row.trigger,
    text: row.text,
    sessionId: row.sessionId,
    createdAtMs: row.createdAtMs,
    state: row.state.state,
  };

  if (row.state.state === "fired") {
    return {
      ...base,
      firedAtMs: row.state.firedAtMs,
      messageId: row.state.messageId,
      ...(row.firedBecause === undefined ? {} : { firedBecause: row.firedBecause }),
    };
  }

  if (row.state.state === "cancelled") {
    return { ...base, cancelledAtMs: row.state.cancelledAtMs, reason: row.state.reason };
  }

  return { ...base, armedAtMs: row.state.fireAtMs };
}
