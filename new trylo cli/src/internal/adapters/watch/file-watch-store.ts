import { existsSync } from "node:fs";

import {
  cancelWatch,
  evaluateCondition,
  watchFireMoment,
  watchOccurrenceId,
  type ConditionProbe,
} from "../../domain/watch.js";
import {
  MAX_WATCHES_PER_SESSION,
  type WatchClock,
  type WatchFailureCode,
  type WatchId,
  type WatchPort,
  type WatchRefusal,
  type WatchResult,
  type WatchRow,
  type WatchTrigger,
} from "../../ports/watch.js";
import type { Occurrence } from "../../ports/schedule.js";
import { decodeWatch, encodeWatch, readRows } from "./row.js";

/**
 * The durable watch store (WP26 / A07).
 *
 * ## Where the records live, and why
 *
 * In the **schedule store's** file, as rows of its own kind. A watch is an
 * occurrence with a condition attached; a parallel file would mean two writers,
 * two locks, and a way for a watch to outlive the schedule record that would have
 * fired it.
 *
 * ## How "fires once" is actually guaranteed
 *
 * By an **occurrence row appended next to the watch** when it fires, keyed by the
 * derived id `watch_<id>@<fireMomentMs>`. A watch that is still `armed` but whose
 * occurrence exists has fired, whatever the watch row says — which is what makes
 * the guarantee survive a restart and survive a hand-edited file, rather than
 * resting on a `fired: true` flag in memory.
 *
 * Both kinds derive their occurrence from the watch's own identity via
 * `domain/watch.ts::watchFireMoment` — a deadline from its own `atMs`, a
 * condition watch from its `createdAtMs`. Deriving a condition watch from the
 * moment the fire was observed instead would break crash recovery: the second
 * derivation would land on a different moment, find nothing, and fire again.
 */

export type FileWatchStoreOptions = {
  /** The record this store shares with the scheduler. */
  readonly file: string;
  /**
   * Rewrites the record's `schedules` array, leaving everything else alone.
   *
   * A callback rather than a store object, because the watch rows live in the
   * same array as the cron rows and a second writer on that file would be the
   * race ADR §5 rules out.
   */
  readonly writeRows: (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) => boolean;
  readonly clock: WatchClock;
  readonly probe: ConditionProbe;
  /** What the occurrence rows currently hold for these watches. */
  readonly occurrences: () => Promise<ReadonlyArray<Occurrence>>;
};

/**
 * Total armed watches across all sessions in one record file.
 *
 * Per-session `MAX_WATCHES_PER_SESSION` (20) alone allows 100 sessions × 20 =
 * 2000 rows; a shared record that large slows every tick's read. 200 keeps the
 * file bounded while leaving headroom for legitimate multi-session use.
 */
export const MAX_WATCHES_TOTAL = 200;

/**
 * Session id shape, mirrored from `surface/cli/session-paths.ts::isValidSessionId`.
 *
 * Duplicated rather than imported so this adapter stays independent of the
 * surface layer (ports own the contract, the surface owns the path formula).
 * Change both together; the store test pins the shape.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isUsableSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value) && !value.includes("..");
}


export function createFileWatchStore(options: FileWatchStoreOptions): WatchPort {
  function refusal(code: WatchFailureCode, message: string): WatchRefusal {
    return { ok: false, code, message };
  }

  function watches(sessionId?: string): ReadonlyArray<WatchRow> {
    const wanted = sessionId?.trim();
    const found: Array<WatchRow> = [];

    for (const row of readRows(options.file)) {
      const decoded = decodeWatch(row);
      // Compare trimmed on both sides: rows written before trim-normalisation
      // may carry surrounding spaces, and `" s-1 "` must not bypass the ceiling.
      if (decoded !== undefined && (wanted === undefined || decoded.sessionId.trim() === wanted)) {
        found.push(decoded);
      }
    }

    return found.sort((left, right) => right.createdAtMs - left.createdAtMs);
  }

  function find(watchId: WatchId): WatchRow | undefined {
    return watches().find((row) => row.id === watchId);
  }


  /** Replace one watch row, leaving every other row untouched. */
  function replace(watchId: WatchId, next: WatchRow): boolean {
    return options.writeRows(
      readRows(options.file).map((row) => (row["kind"] === "watch" && row["watchId"] === watchId ? encodeWatch(next) : row)),
    );
  }


  /**
   * The occurrence that already records this fire, if there is one.
   *
   * Returns the occurrence rather than a boolean because it also answers *which*
   * attempt was recorded — and that is what lets a second caller be told the
   * message the first one left, instead of a second notification with a new id.
   * A boolean would force the caller to invent one, which is precisely the
   * duplicate this whole mechanism exists to prevent.
   */
  async function recordedFire(row: WatchRow): Promise<Occurrence | undefined> {
    const id = watchOccurrenceId(row.id, watchFireMoment(row));
    return (await options.occurrences()).find((occurrence) => occurrence.id === id);
  }

  async function evaluateRow(
    row: WatchRow,
  ): Promise<WatchResult<{ readonly met: boolean; readonly because?: string }>> {
    if (row.trigger.kind === "deadline") {
      const met = options.clock.now() >= row.trigger.atMs;
      return {
        ok: true,
        value: met
          ? { met: true, because: `the moment ${new Date(row.trigger.atMs).toISOString()} arrived` }
          : { met: false },
      };
    }

    const verdict = evaluateCondition(row.trigger.condition, options.probe);

    return verdict.met
      ? { ok: true, value: { met: true, because: verdict.because } }
      : { ok: true, value: { met: false } };
  }

  async function arm(
    input: { readonly trigger: WatchTrigger; readonly text: string; readonly sessionId: string },
    allowPastDeadline: boolean,
  ): Promise<WatchResult<WatchRow>> {
    if (input.text.trim().length === 0) {
      return refusal("blank_text", "a watch with no message would fire to say nothing");
    }

    // Normalise once: `" s-1 "` and `"s-1"` are the same session, and counting
    // them separately would let spaced ids bypass the per-session ceiling.
    const sessionId = input.sessionId.trim();
    if (sessionId.length === 0) {
      return refusal("not_a_session", "a watch needs a session to deliver to; pass --session <id>");
    }

    if (!isUsableSessionId(sessionId)) {
      return refusal(
        "not_a_session",
        "that session id cannot name a queue file; use letters, digits, dot, dash or underscore, never containing ..",
      );
    }

    if (input.trigger.kind === "deadline" && input.trigger.atMs <= options.clock.now() && !allowPastDeadline) {
      return refusal(
        "invalid_deadline",
        "that moment has already passed; use the immediate form if you want it fired now",
      );
    }

    const armedForSession = watches(sessionId).filter((row) => row.state.state === "armed").length;
    if (armedForSession >= MAX_WATCHES_PER_SESSION) {
      return refusal(
        "too_many_watches",
        `this session already has ${armedForSession} armed watches; cancel one before arming another`,
      );
    }

    const armedTotal = watches().filter((row) => row.state.state === "armed").length;
    if (armedTotal >= MAX_WATCHES_TOTAL) {
      return refusal(
        "too_many_watches",
        `the record already holds ${armedTotal} armed watches; cancel one before arming another`,
      );
    }

    const nowMs = options.clock.now();
    const id = options.clock.newWatchId();
    const fireAtMs = input.trigger.kind === "deadline" ? input.trigger.atMs : nowMs;
    const row: WatchRow = {
      id,
      trigger: input.trigger,
      state: { state: "armed", watchId: id, fireAtMs },
      text: input.text,
      sessionId,
      createdAtMs: nowMs,
    };

    return options.writeRows([...readRows(options.file), encodeWatch(row)])
      ? { ok: true, value: row }
      : refusal("watch_unwritable", "the watch record could not be written, so nothing was armed");
  }

  /**
   * Record the fire.
   *
   * `because` is written into the row rather than taken as a message: the reason
   * a condition became true is what makes a fire intelligible an hour later, and
   * a caller that only got the message would have to re-derive it.
   */
  async function settleFire(
    row: WatchRow,
    because: string,
    observedAtMs: number,
    messageId: string,
  ): Promise<WatchResult<{ readonly row: WatchRow; readonly messageId: string }>> {
    const alreadyRecorded = await recordedFire(row);
    if (alreadyRecorded !== undefined) {
      // Already recorded. The **occurrence** is the authority here, not the row:
      // the whole point of the check is that the row may still say `armed` — which
      // is exactly what a crash between "fired" and "wrote the row" leaves behind.
      // Reading the row here would return `armed`, and a caller would then believe
      // it had not fired yet and try again.
      const existing = find(row.id);
      // The message id comes from whichever record survived: the occurrence when it
      // carries one (the crash case, where the row was lost), the row otherwise.
      const recordedMessageId =
        existing?.state.state === "fired" ? existing.state.messageId : messageIdFrom(alreadyRecorded, messageId);

      return {
        ok: true,
        value: {
          row: {
            ...(existing ?? row),
            state: { state: "fired", watchId: row.id, firedAtMs: observedAtMs, messageId: recordedMessageId },
            ...(existing?.firedBecause === undefined ? { firedBecause: because } : {}),
          },
          messageId: recordedMessageId,
        },
      };
    }

    const fired: WatchRow = {
      ...row,
      state: { state: "fired", watchId: row.id, firedAtMs: observedAtMs, messageId },
    };
    const recorded: WatchRow = { ...fired, firedBecause: because };
    if (!replace(row.id, recorded)) {
      return refusal("watch_unwritable", "the fire was not recorded, so the watch is still armed");
    }

    return { ok: true, value: { row: recorded, messageId } };
  }

  /**
   * The message an already-recorded occurrence carries, if any.
   *
   * Occurrences settle with whatever the runner recorded, which is a receipt
   * rather than a queue id — so this reads the receipt's own `messageId` when it
   * has one and falls back to what this caller proposed.
   */
  function messageIdFrom(occurrence: Occurrence, fallback: string): string {
    if (occurrence.state.state === "completed") {
      const recorded = occurrence.state.result["messageId"];
      if (typeof recorded === "string" && recorded.length > 0) {
        return recorded;
      }
    }

    if (occurrence.state.state === "unknown" && typeof occurrence.state.reason === "string") {
      return fallback;
    }

    return fallback;
  }

  return {
    async list(sessionId) {
      if (!existsSync(options.file) && readRows(options.file).length === 0) {
        return { ok: true, value: [] };
      }
      return { ok: true, value: watches(sessionId) };
    },

    create(input) {
      return arm(input, false);
    },

    async createOrFire(input) {
      const armed = await arm(input, true);
      if (!armed.ok) {
        return armed;
      }

      const row = armed.value;
      const verdict = await evaluateRow(row);
      if (!verdict.ok || !verdict.value.met) {
        return { ok: true, value: { row, fired: false } };
      }

      const settled = await settleFire(
        row,
        verdict.value.because ?? "the condition was met",
        options.clock.now(),
        row.id,
      );
      if (!settled.ok) {
        return settled;
      }

      // The **settled** row, not the one `arm` produced: handing back an
      // `armed` row would leave the caller holding a state the record on disk
      // contradicts, and that disagreement only surfaces when someone cancels
      // something they were told had already fired.
      return {
        ok: true,
        value: { row: settled.value.row, fired: true, messageId: settled.value.messageId },
      };
    },

    async cancel(watchId) {
      const row = find(watchId);
      // The domain decides from the *state*, not from the row, so the rule lives in
      // one place and this layer cannot have a second opinion about it.
      const verdict = cancelWatch(row?.state, watchId, options.clock.now());

      switch (verdict.kind) {
        case "not_found":
          return refusal("watch_not_found", verdict.message);
        case "already_fired":
          return refusal(
            "already_fired",
            `watch ${watchId} already fired; the work happened and cannot be recalled`,
          );
        case "already_cancelled":
          return refusal("already_cancelled", `watch ${watchId} was already cancelled`);
        case "cancelled":
          break;
      }

      const next: WatchRow = { ...(row as WatchRow), state: verdict.state };

      return replace(watchId, next)
        ? { ok: true, value: verdict.state }
        : refusal("watch_unwritable", "the watch record could not be written, so nothing was cancelled");
    },

    async evaluate(watchId) {
      const row = find(watchId);
      if (row === undefined) {
        return refusal("watch_not_found", `no watch ${watchId}`);
      }
      return evaluateRow(row);
    },

    async fire(watchId, atMs, messageId) {
      const row = find(watchId);
      if (row === undefined) {
        return refusal("watch_not_found", `no watch ${watchId}`);
      }

      if (row.state.state !== "armed") {
        // A terminal watch reports what it is. Firing it again would produce a
        // second notification for a condition that has not changed.
        return { ok: true, value: row.state };
      }

      const settled = await settleFire(row, `fired at ${new Date(atMs).toISOString()}`, atMs, messageId);

      return settled.ok ? { ok: true, value: settled.value.row.state } : settled;
    },

    async settled(watchId) {
      const all = await options.occurrences();
      return { ok: true, value: all.filter((occurrence) => occurrence.scheduleId === `watch_${watchId}`) };
    },

    async forget(watchId) {
      // The store owns this guard, not the caller: an armed watch deleted here
      // is a promise silently dropped, and a CLI pre-check alone leaves every
      // other caller (daemon step, tool, hand-rolled script) unguarded.
      // Contract: `ports/watch.ts` — "Drop a terminal watch's record. Never
      // touches an armed one."
      const decoded = find(watchId);
      if (decoded?.state.state === "armed") {
        return refusal(
          "not_terminal",
          `watch ${watchId} is still armed; only fired or cancelled watches can be forgotten`,
        );
      }

      const current = readRows(options.file);
      const kept = current.filter((row) => !(row["kind"] === "watch" && row["watchId"] === watchId));
      if (kept.length === current.length) {
        return refusal("watch_not_found", `no watch ${watchId}`);
      }

      return options.writeRows(kept)
        ? { ok: true, value: true }
        : refusal("watch_unwritable", "the watch record could not be written");
    },
  };
}
