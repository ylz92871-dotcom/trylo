import { readFileSync } from "node:fs";

import type { JsonObject, JsonValue } from "../../protocol/envelope.js";

import type {
  Occurrence,
  OccurrenceState,
  Schedule,
  ScheduleResult,
} from "../../ports/schedule.js";
import { rewriteAll } from "../queue-store/queue-file.js";

/**
 * The durable schedule record, and the codec that guards it (WP26 / A06).
 *
 * ## What is stored, and why the file has two halves
 *
 * `{ schedules, occurrences }` in one file, written whole. Occurrences are kept
 * rather than re-derived on every read because a *settled* occurrence is a fact
 * about something that already happened: re-deriving "did that run" from the
 * cron and the clock would make the answer depend on when it is asked, and a
 * crashed run would look identical to a pending one.
 *
 * One file rather than two because the two halves must move together. A
 * schedule tombstoned in one file and its in-flight occurrence in another is a
 * state where the delete looks complete and the work still runs.
 *
 * ## Durability, inherited rather than reinvented
 *
 * `rewriteAll` (`adapters/queue-store/queue-file.ts`) already provides the two
 * properties this file needs: a write is fsynced before it is acknowledged, and
 * a rewrite goes through a temporary file and a rename so a reader never sees a
 * half-written record. Copying that logic here would be a second implementation
 * of the one guarantee that decides whether a crash loses a person's schedule.
 *
 * ## Reading is validated, never cast
 *
 * A hand-edited or truncated file is read field by field and a row that does not
 * typecheck is dropped with its index reported. A blind cast would turn one bad
 * row into a `Schedule` whose `cron` is `undefined`, and the failure would
 * surface much later as a scheduler that silently stops firing.
 *
 * Tombstoned rows are **kept**, not filtered on read. They are what stops a
 * crash between "tombstone" and "prune" from resurrecting deleted work.
 */

const SCHEDULE_FILE_REL = "schedule/schedules.json";

export const SCHEDULE_FILE_VERSION = 1;

type StoredFile = {
  readonly version: number;
  readonly schedules: ReadonlyArray<Schedule>;
  readonly occurrences: ReadonlyArray<Occurrence>;
};

/** Where the record lives. Derived from the one home formula, never re-spelled. */
export function scheduleFilePath(home: string): string {
  return `${home}/${SCHEDULE_FILE_REL}`;
}

function emptyFile(): StoredFile {
  return { version: SCHEDULE_FILE_VERSION, schedules: [], occurrences: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one schedule row.
 *
 * Returns `null` for anything that does not typecheck, which is the only safe
 * answer: a schedule with a missing `cron` cannot be fired, and one with a
 * missing `prompt` cannot be run, so neither is a schedule.
 */
function decodeSchedule(raw: unknown): Schedule | null {
  if (!isRecord(raw)) {
    return null;
  }

  const { id, cron, prompt, createdAtMs, recurring, durable, delivery, sessionId, permanent, lastFiredAtMs, tombstonedAtMs } = raw;

  if (typeof id !== "string" || id.length === 0) return null;

  if (typeof cron !== "string" || cron.length === 0) return null;

  if (typeof prompt !== "string") return null;

  if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return null;

  if (delivery !== "queue" && delivery !== "wait") return null;

  if (sessionId !== undefined && typeof sessionId !== "string") return null;

  if (permanent !== undefined && typeof permanent !== "boolean") return null;

  if (lastFiredAtMs !== undefined && (typeof lastFiredAtMs !== "number" || !Number.isFinite(lastFiredAtMs))) return null;

  if (tombstonedAtMs !== undefined && (typeof tombstonedAtMs !== "number" || !Number.isFinite(tombstonedAtMs))) return null;

  return {
    id,
    cron,
    prompt,
    createdAtMs,
    recurring: recurring === true,
    durable: durable === true,
    delivery,
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(permanent === true ? { permanent: true } : {}),
    ...(typeof lastFiredAtMs === "number" ? { lastFiredAtMs } : {}),
    ...(typeof tombstonedAtMs === "number" ? { tombstonedAtMs } : {}),
  };
}

/** Validate one occurrence row; same reasoning as `decodeSchedule`. */
function decodeOccurrence(raw: unknown): Occurrence | null {
  if (!isRecord(raw)) {
    return null;
  }

  const { id, scheduleId, dueAtMs, state, prompt, delivery, sessionId } = raw;

  if (typeof id !== "string" || typeof scheduleId !== "string") return null;

  if (typeof dueAtMs !== "number" || !Number.isFinite(dueAtMs)) return null;

  if (typeof prompt !== "string") return null;

  if (delivery !== "queue" && delivery !== "wait") return null;

  if (sessionId !== undefined && typeof sessionId !== "string") return null;

  const decodedState = decodeState(state);
  if (decodedState === null) return null;

  return {
    id,
    scheduleId,
    dueAtMs,
    state: decodedState,
    prompt,
    delivery,
    ...(typeof sessionId === "string" ? { sessionId } : {}),
  };
}

/** Depth bound for the recursive narrowing below; ample for real payloads. */
const MAX_JSON_DEPTH = 32;

/**
 * Narrow a stored JSON value.
 *
 * `undefined` means "not representable in JSON" and `null` means "the JSON null",
 * so the two are never confused: a caller comparing the result against the input
 * tells them apart, and the recursive calls below do exactly that.
 *
 * Needed because `OccurrenceState.completed` carries a `JsonObject`, while the
 * narrowing that produced it (`isRecord`) yields `Record<string, unknown>`, which
 * is *not* assignable to `JsonObject` — `unknown` is not a `JsonValue`. A cast
 * would silence exactly the check that matters, so the value is walked and
 * rebuilt instead, and a partially-decoded object never escapes: one
 * unrepresentable entry fails the whole value.
 *
 * The depth bound is a cycle guard rather than a style choice. `JSON.parse`
 * cannot produce a cycle, but tests build values by hand and an unbounded
 * recursion is a stack overflow waiting for one.
 */
function narrowJsonValue(value: unknown, depth: number): JsonValue | undefined {
  if (depth > MAX_JSON_DEPTH) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint: not representable in JSON.
      return undefined;
  }

  if (Array.isArray(value)) {
    const entries: Array<JsonValue> = [];

    for (const entry of value) {
      const narrowed = narrowJsonValue(entry, depth + 1);
      if (narrowed === undefined) {
        return undefined;
      }
      entries.push(narrowed);
    }

    return entries;
  }

  return narrowJsonObject(value as Record<string, unknown>, depth + 1);
}

/**
 * Narrow a record into a `JsonObject`, or `undefined`.
 *
 * Separate from {@link narrowJsonValue} because the object case has to *build* a
 * `JsonObject`, and `JsonObject` is a readonly index signature that cannot be
 * written into: entries are collected in a mutable map and frozen by
 * `Object.fromEntries`. Returning `JsonValue` from the shared function and
 * asserting it down to `JsonObject` is the double cast this package refuses.
 */
function narrowJsonObject(value: Record<string, unknown>, depth: number): JsonObject | undefined {
  if (depth > MAX_JSON_DEPTH) {
    return undefined;
  }

  const entries = new Map<string, JsonValue>();

  for (const [key, entry] of Object.entries(value)) {
    const narrowed = narrowJsonValue(entry, depth);
    if (narrowed === undefined) {
      return undefined;
    }
    entries.set(key, narrowed);
  }

  return Object.fromEntries(entries);
}

/**
 * Validate one occurrence state.
 *
 * Every branch checks the fields its own variant needs, so a `completed` row
 * missing `completedAtMs` is dropped rather than becoming a completion nobody
 * can date. An unreadable state is never coerced to `due` — that would make a
 * finished occurrence due again.
 */
function decodeState(raw: unknown): OccurrenceState | null {
  if (!isRecord(raw) || typeof raw["state"] !== "string") {
    return null;
  }
  switch (raw["state"]) {
    case "due":
      return { state: "due" };
    case "claimed": {
      const attemptId = raw["attemptId"];
      const claimedAtMs = raw["claimedAtMs"];
      if (typeof attemptId !== "string" || typeof claimedAtMs !== "number") return null;
      return { state: "claimed", attemptId, claimedAtMs };
    }
    case "dispatched": {
      const attemptId = raw["attemptId"];
      const dispatchedAtMs = raw["dispatchedAtMs"];
      if (typeof attemptId !== "string" || typeof dispatchedAtMs !== "number") return null;
      return { state: "dispatched", attemptId, dispatchedAtMs };
    }
    case "completed": {
      const attemptId = raw["attemptId"];
      const completedAtMs = raw["completedAtMs"];
      const result = raw["result"];

      if (typeof attemptId !== "string" || typeof completedAtMs !== "number") return null;

      if (!isRecord(result)) return null;

      const narrowedResult = narrowJsonObject(result, 0);
      if (narrowedResult === undefined) return null;

      return { state: "completed", attemptId, completedAtMs, result: narrowedResult };
    }
    case "failed": {
      const attemptId = raw["attemptId"];
      const failedAtMs = raw["failedAtMs"];
      const code = raw["code"];
      const message = raw["message"];

      if (typeof attemptId !== "string" || typeof failedAtMs !== "number") return null;

      if (typeof code !== "string" || typeof message !== "string") return null;

      return { state: "failed", attemptId, failedAtMs, code, message };
    }
    case "cancelled": {
      const cancelledAtMs = raw["cancelledAtMs"];
      const reason = raw["reason"];
      if (typeof cancelledAtMs !== "number" || typeof reason !== "string") return null;
      return { state: "cancelled", cancelledAtMs, reason };
    }
    case "unknown": {
      const attemptId = raw["attemptId"];
      const observedAtMs = raw["observedAtMs"];
      const reason = raw["reason"];
      if (typeof attemptId !== "string" || typeof observedAtMs !== "number") return null;
      if (typeof reason !== "string") return null;
      return { state: "unknown", attemptId, observedAtMs, reason };
    }
    default:
      return null;
  }
}

/**
 * Read the record.
 *
 * Absent file is an empty store — a real state, not a failure. A file that
 * exists but does not parse is `schedule_unreadable`, which is deliberately
 * *not* the same answer: "you have no schedules" and "I could not read yours"
 * lead a person to opposite conclusions, and only one of them is true.
 */
export function readScheduleFile(file: string): ScheduleResult<StoredFile> {
  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch (error: unknown) {
    // ENOENT is the ordinary first run; anything else is a real failure and is
    // reported as one rather than as an empty schedule list.
    if ((error as { code?: string } | null)?.code === "ENOENT") {
      return { ok: true, value: emptyFile() };
    }
    return { ok: false, code: "schedule_unreadable", message: `could not read ${file}: ${String(error)}` };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schedule_unreadable", message: `${file} is not valid JSON` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, code: "schedule_unreadable", message: `${file} is not an object` };
  }

  const schedules = Array.isArray(parsed["schedules"]) ? parsed["schedules"] : [];
  const occurrences = Array.isArray(parsed["occurrences"]) ? parsed["occurrences"] : [];

  return {
    ok: true,
    value: {
      version: typeof parsed["version"] === "number" ? parsed["version"] : SCHEDULE_FILE_VERSION,
      schedules: schedules.map(decodeSchedule).filter((row): row is Schedule => row !== null),
      occurrences: occurrences.map(decodeOccurrence).filter((row): row is Occurrence => row !== null),
    },
  };
}

/** Write the record whole. False means the caller must not claim it was saved. */
export function writeScheduleFile(file: string, value: StoredFile): boolean {
  return rewriteAll(file, JSON.stringify(value, null, 2) + "\n");
}

/**
 * The lease as it is persisted.
 *
 * Exported because the recovery story needs it: a lease whose holder died must
 * be reclaimable by *someone*, and the only safe way to tell that holder is gone
 * is the process liveness probe in `schedule-lease.ts` — not a timestamp here.
 */
export type LeaseRecord = {
  readonly ownerId: string;
  /** Opaque token; a writer must present it, so a guesser cannot write. */
  readonly token: string;
  readonly pid: number;
  readonly acquiredAtMs: number;
};
