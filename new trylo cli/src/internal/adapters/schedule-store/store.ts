import { randomUUID } from "node:crypto";

import {
  MAX_SCHEDULES,
  type Occurrence,
  type Schedule,
  type ScheduleClock,
  type SchedulePort,
  type ScheduleResult,
} from "../../ports/schedule.js";
import {
  deleteConsequence,
  dueOccurrences,
  leaseIsValid,
  settledState,
  shouldRetireAfterFire,
  validateSchedule,
} from "../../domain/schedule.js";
import { readScheduleFile, scheduleFilePath, writeScheduleFile, type LeaseRecord } from "./codec.js";
import { acquireLease, readLease, releaseLease } from "./lease.js";

/**
 * The file-backed schedule store (WP26 / A06).
 *
 * ## One writer, and what happens when there are two
 *
 * Every mutating verb requires the lease token. A caller holding a stale token
 * gets `lease_lost` and must stop — not retry. That is the fencing rule: the new
 * owner may already have claimed the occurrence this one is about to write, so
 * a stale writer that retries is not behind, it is racing.
 *
 * ## The crash windows, and what each one leaves behind
 *
 * There are exactly two, and both are recoverable because the occurrence id is
 * derived rather than generated:
 *
 *  - Crash after `claimDue` wrote, before the runner was handed the occurrence.
 *    The record says `claimed` with an attempt id. Nothing ran, so recovery may
 *    re-dispatch it — the attempt id changes and the earlier claim is visible.
 *  - Crash after the effect landed, before `settle`. The record still says
 *    `claimed` or `dispatched`. Recovery **cannot** tell whether the effect
 *    happened, so it marks the occurrence `unknown` and hands it to
 *    reconciliation. It does not retry: an unattended job whose result nobody
 *    observed is exactly where a blind retry does the work twice.
 *
 * ## Why the recurrence anchor is written on settle, not on claim
 *
 * `lastFiredAtMs` moves only when an occurrence settles. Moving it at claim time
 * would lose the fire if the process died between claim and run, and the
 * occurrence would silently never happen; moving it after settle is what makes
 * "fired" mean "ran and was recorded".
 */
export type FileScheduleStoreOptions = {
  /** The one home directory; the path is derived, never spelled out twice. */
  readonly home: string;
  readonly clock: ScheduleClock;
  /** This process's identity in the lease. Stable for the process's lifetime. */
  readonly ownerId: string;
  readonly pid: number;
  /** Ceiling on how long a recurring schedule may live; 0 means unlimited. */
  readonly recurringMaxAgeMs: number;
};

export function createFileScheduleStore(options: FileScheduleStoreOptions): SchedulePort {
  const file = scheduleFilePath(options.home);
  const lockPath = `${file}.lock`;
  const now = options.clock.now;
  let token: string | undefined;

  function load(): ScheduleResult<{ schedules: Schedule[]; occurrences: Occurrence[] }> {
    const read = readScheduleFile(file);
    if (!read.ok) {
      return read;
    }

    return {
      ok: true,
      value: {
        schedules: [...read.value.schedules],
        occurrences: [...read.value.occurrences],
      },
    };
  }

  function save(schedules: ReadonlyArray<Schedule>, occurrences: ReadonlyArray<Occurrence>): ScheduleResult<true> {
    const wrote = writeScheduleFile(file, { version: 1, schedules, occurrences });
    return wrote
      ? { ok: true, value: true }
      : { ok: false, code: "schedule_unwritable", message: `could not write ${file}` };
  }

  /**
   * Refuse a write from a caller that is not the lease holder.
   *
   * The token is re-checked against the file on every call rather than trusted
   * from a closure, because the whole point is that another process may have
   * taken the lease since the last call.
   */
  function requireLease(presented: string): ScheduleResult<{ readonly ownerId: string; readonly token: string }> {
    if (presented.length === 0) {
      return { ok: false, code: "lease_lost", message: "no lease token presented" };
    }
    const held = readLease(lockPath);
    const check = leaseIsValid(held.held ? held : undefined, presented, options.ownerId);
    return check.ok ? { ok: true, value: { ownerId: options.ownerId, token: presented } } : check;
  }

  return {
    async list() {
      const loaded = load();
      if (!loaded.ok) {
        return loaded;
      }
      const live = loaded.value.schedules.filter((schedule) => schedule.tombstonedAtMs === undefined);
      return { ok: true, value: live.sort((left, right) => left.createdAtMs - right.createdAtMs) };
    },

    async create(input) {
      const validated = validateSchedule(input);
      if (!validated.ok) {
        return validated;
      }

      const loaded = load();
      if (!loaded.ok) {
        return loaded;
      }

      const live = loaded.value.schedules.filter((schedule) => schedule.tombstonedAtMs === undefined);
      if (live.length >= MAX_SCHEDULES) {
        return {
          ok: false,
          code: "too_many_schedules",
          message: `too many schedules (max ${MAX_SCHEDULES}); delete one first`,
        };
      }

      const schedule: Schedule = {
        ...validated.value,
        id: `sch_${randomUUID().slice(0, 8)}`,
        createdAtMs: now(),
      };
      const saved = save([...loaded.value.schedules, schedule], loaded.value.occurrences);
      if (!saved.ok) {
        return saved;
      }

      return { ok: true, value: schedule };
    },

    async delete(scheduleId) {
      const loaded = load();
      if (!loaded.ok) {
        return loaded;
      }

      const index = loaded.value.schedules.findIndex((schedule) => schedule.id === scheduleId);
      if (index < 0) {
        return { ok: false, code: "unknown_schedule", message: `no schedule ${scheduleId}` };
      }

      const existing = loaded.value.schedules[index] as Schedule;
      if (existing.tombstonedAtMs !== undefined) {
        return {
          ok: false,
          code: "already_tombstoned",
          message: `schedule ${scheduleId} was already deleted at ${new Date(existing.tombstonedAtMs).toISOString()}`,
        };
      }

      const consequence = deleteConsequence(existing, loaded.value.occurrences);
      // A tombstone is still written for the in-flight cases: the schedule must
      // stop producing new work even though an attempt already exists. What is
      // *not* done is pretending the in-flight work stopped — that is what the
      // consequence reports, and the caller decides whether to cancel the runner.
      const tombstoned: Schedule = { ...existing, tombstonedAtMs: now() };
      const schedules = [...loaded.value.schedules];

      schedules[index] = tombstoned;
      const saved = save(schedules, loaded.value.occurrences);
      if (!saved.ok) {
        return saved;
      }

      if (consequence.kind === "already_tombstoned") {
        return { ok: false, code: "already_tombstoned", message: `schedule ${scheduleId} is gone` };
      }

      return { ok: true, value: true };
    },

    async acquireLease(ownerId) {
      if (token !== undefined) {
        // Re-entrant: this store already holds it, so hand back the same token.
        // A second token would mean the first is orphaned and the fencing check
        // could no longer tell which writer is current.
        return { ok: true, value: token };
      }

      const took = acquireLease(lockPath, ownerId, options.pid, {
        now,
        newToken: () => randomUUID(),
      });
      if (!took.ok) {
        const holder = took.held.held ? `${took.held.ownerId} (pid ${took.held.pid})` : "another process";
        return {
          ok: false,
          code: "not_owner",
          message: `the scheduler lease is held by ${holder}; only one scheduler may run`,
        };
      }

      token = took.token;

      return { ok: true, value: took.token };
    },

    async releaseLease() {
      if (token === undefined) {
        return;
      }
      releaseLease(lockPath, options.ownerId, token);
      token = undefined;
    },

    async claimDue(nowMs, leaseToken) {
      const permitted = requireLease(leaseToken);
      if (!permitted.ok) {
        return permitted;
      }

      const loaded = load();
      if (!loaded.ok) {
        return loaded;
      }

      const settled = new Set(
        loaded.value.occurrences
          .filter((occurrence) => occurrence.state.state !== "due")
          .map((occurrence) => occurrence.id),
      );
      const derived = dueOccurrences(
        loaded.value.schedules.filter((schedule) => schedule.tombstonedAtMs === undefined),
        nowMs,
      ).filter((occurrence) => !settled.has(occurrence.id));
      if (derived.length === 0) {
        return { ok: true, value: [] };
      }

      const claimedAtMs = nowMs;
      const claimed = derived.map((occurrence): Occurrence => ({
        ...occurrence,
        state: { state: "claimed", attemptId: options.clock.newAttemptId(), claimedAtMs },
      }));
      const saved = save(
        loaded.value.schedules,
        [...loaded.value.occurrences, ...claimed],
      );
      if (!saved.ok) {
        return saved;
      }

      return { ok: true, value: claimed };
    },

    async settle(occurrenceId, outcome, leaseToken) {
      const permitted = requireLease(leaseToken);
      if (!permitted.ok) {
        return permitted;
      }

      const loaded = load();
      if (!loaded.ok) {
        return loaded;
      }

      const index = loaded.value.occurrences.findIndex((occurrence) => occurrence.id === occurrenceId);
      if (index < 0) {
        return { ok: false, code: "unknown_schedule", message: `no occurrence ${occurrenceId}` };
      }

      const current = loaded.value.occurrences[index] as Occurrence;
      if (
        current.state.state === "completed" ||
        current.state.state === "failed" ||
        current.state.state === "cancelled" ||
        current.state.state === "unknown"
      ) {
        // Already terminal. Settling twice must not rewrite history: a late
        // duplicate from a retried caller — or a runner that never heard the
        // cancel — would otherwise replace a recorded terminal (a failure, a
        // cancellation, an unobserved effect) with a success nobody observed.
        return { ok: true, value: current };
      }

      const settledAtMs = now();
      const settled: Occurrence = {
        ...current,
        state: settledState(current.state, outcome, settledAtMs),
      };
      const occurrences = [...loaded.value.occurrences];

      occurrences[index] = settled;
      // The recurrence anchor advances only here — see the file comment on the
      // crash windows.
      const schedules = advanceAnchors(
        loaded.value.schedules,
        settled,
        settledAtMs,
        options.recurringMaxAgeMs,
      );
      const saved = save(schedules, occurrences);
      if (!saved.ok) {
        return saved;
      }

      return { ok: true, value: settled };
    },

    async occurrenceStatesOf(scheduleId) {
      const loaded = load();
      if (!loaded.ok) {
        return loaded;
      }

      return {
        ok: true,
        value: loaded.value.occurrences
          .filter((occurrence) => occurrence.scheduleId === scheduleId)
          .map((occurrence) => occurrence.state),
      };
    },

    async listOccurrences() {
      const loaded = load();
      // A record that cannot be read answers with an empty list rather than a
      // refusal: the caller is checking what has *already fired*, and "I could
      // not tell" must not read as "nothing has".
      return loaded.ok ? loaded.value.occurrences : [];
    },
  };
}

/**
 * Move `lastFiredAtMs` for the schedule this occurrence belonged to, and retire
 * the schedule when it is done.
 *
 * Retirement writes a tombstone rather than deleting the row, so a crash between
 * the decision and the prune cannot bring the schedule back. The reused source
 * deleted rows outright, which is why its "deleted" state was only ever the
 * absence of a line in a file.
 */
function advanceAnchors(
  schedules: ReadonlyArray<Schedule>,
  settled: Occurrence,
  settledAtMs: number,
  recurringMaxAgeMs: number,
): ReadonlyArray<Schedule> {
  return schedules.map((schedule) => {
    if (schedule.id !== settled.scheduleId || schedule.tombstonedAtMs !== undefined) {
      return schedule;
    }

    const advanced: Schedule = { ...schedule, lastFiredAtMs: settledAtMs };

    return shouldRetireAfterFire(advanced, settledAtMs, recurringMaxAgeMs)
      ? { ...advanced, tombstonedAtMs: settledAtMs }
      : advanced;
  });
}

export type { LeaseRecord };
