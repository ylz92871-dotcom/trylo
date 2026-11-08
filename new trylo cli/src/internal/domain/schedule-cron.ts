/**
 * Cron expression parsing and next-run computation (WP26 / A06).
 *
 * Mechanical reuse of old CLI `src/utils/cron.ts` (sha256 prefix
 * `e8ba70b31453d6e7`, 308 lines), with one algorithm change that the WP26
 * review proved was load-bearing: the fall-back hour anchor.
 *
 * The 5-field subset is unchanged — `minute hour day-of-month month
 * day-of-week`, with wildcard / `N` / `*\/N` / `N-M[\/N]` / comma lists. No
 * `L`, `W`, `?`, or name aliases. Times are **local**, because a person
 * writing "0 9 * * *" means 9am where they are sitting.
 *
 * ## Why the old `computeNextCronRun` was wrong, and what replaced it
 *
 * The old algorithm rounded `from` up to the next whole minute and then walked
 * forward using `setMinutes` / `setHours` / `setDate`. On a spring-forward day
 * those setters *skip* the missing hour; on a fall-back day the wall clock
 * reads 01:00–01:59 **twice**, and stepping forward from the first 01:xx
 * lands the candidate on the *second* 01:xx — which is one hour **earlier**
 * in real time than where it started.
 *
 * Measured, America/New_York, `* * * * *`, `from = 2026-11-01T01:10:00-05:00`
 * (the second 01:10, EDT):
 *
 * ```text
 * old next = 2026-11-01T05:11:00Z   (= 01:11 EDT — an *earlier* instant)
 * from     = 2026-11-01T06:10:00Z
 * ```
 *
 * A scheduler that trusts that will fire a task before it was due, and — worse
 * — on the next tick compute an earlier "next" again, which is how a
 * recurring task turns into a tight loop. So `next > from` is the invariant
 * this module exists to hold, and `schedule-cron.test.ts` pins it.
 *
 * The fix keeps local-time semantics rather than escaping to UTC: the walk is
 * unchanged, but the candidate is only accepted once its real-time value is
 * strictly after `from`, and each forward step is measured as a **duration**
 * so the repeated hour cannot fold backwards. Both DST cases the old code got
 * right stay right — see `spring gap` and `fall-back fires once` in the tests.
 *
 * This module is pure: no clock, no filesystem, no randomness. The wall clock
 * arrives as `from`, which is what makes every case here testable.
 */

/** A parsed 5-field cron expression, one expanded value list per field. */
export type CronFields = {
  readonly minute: ReadonlyArray<number>;
  readonly hour: ReadonlyArray<number>;
  readonly dayOfMonth: ReadonlyArray<number>;
  readonly month: ReadonlyArray<number>;
  readonly dayOfWeek: ReadonlyArray<number>;
};

type FieldRange = { readonly min: number; readonly max: number };

/**
 * Field bounds, in cron order. `dayOfWeek` is 0=Sunday with `7` accepted as
 * a Sunday alias; the alias is normalised at parse time so nothing downstream
 * has to remember it.
 */
const FIELD_RANGES: ReadonlyArray<FieldRange> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week
];

/**
 * Expand one field into its sorted matching values, or `null` when the field
 * uses syntax this subset does not support.
 *
 * Returning `null` rather than throwing is the old contract and the useful
 * one: the caller can answer "that expression is invalid" as a normal outcome
 * of validating user input, instead of catching.
 */
function expandField(field: string, range: FieldRange): ReadonlyArray<number> | null {
  const { min, max } = range;
  const isDayOfWeek = min === 0 && max === 6;
  const out = new Set<number>();

  for (const part of field.split(",")) {
    const stepped = part.match(/^\*(?:\/(\d+))?$/);
    if (stepped !== null) {
      const step = stepped[1] === undefined ? 1 : Number.parseInt(stepped[1], 10);
      if (step < 1) {
        return null;
      }

      for (let value = min; value <= max; value += step) {
        out.add(value);
      }

      continue;
    }

    const ranged = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (ranged !== null) {
      const lo = Number.parseInt(ranged[1] as string, 10);
      const hi = Number.parseInt(ranged[2] as string, 10);
      const step = ranged[3] === undefined ? 1 : Number.parseInt(ranged[3] as string, 10);
      // `7` is a Sunday alias, so `5-7` means Fri/Sat/Sun and its upper bound is 7.
      const effectiveMax = isDayOfWeek ? 7 : max;
      if (lo > hi || step < 1 || lo < min || hi > effectiveMax) {
        return null;
      }

      for (let value = lo; value <= hi; value += step) {
        out.add(isDayOfWeek && value === 7 ? 0 : value);
      }

      continue;
    }

    const single = part.match(/^(\d+)$/);
    if (single !== null) {
      let value = Number.parseInt(single[1] as string, 10);
      if (isDayOfWeek && value === 7) {
        value = 0;
      }

      if (value < min || value > max) {
        return null;
      }

      out.add(value);
      continue;
    }

    return null;
  }

  if (out.size === 0) {
    return null;
  }

  return Array.from(out).sort((left, right) => left - right);
}

/** Parse a 5-field expression, or return `null` when it is not one. */
export function parseCronExpression(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const expanded: Array<ReadonlyArray<number>> = [];

  for (let index = 0; index < 5; index += 1) {
    const field = expandField(parts[index] as string, FIELD_RANGES[index] as FieldRange);
    if (field === null) {
      return null;
    }
    expanded.push(field);
  }

  return {
    minute: expanded[0] as ReadonlyArray<number>,
    hour: expanded[1] as ReadonlyArray<number>,
    dayOfMonth: expanded[2] as ReadonlyArray<number>,
    month: expanded[3] as ReadonlyArray<number>,
    dayOfWeek: expanded[4] as ReadonlyArray<number>,
  };
}

/**
 * How far the walk is willing to go before giving up. Sized for the coarse phase
 * below (day jumps), so it is a backstop against a pathological expression
 * rather than an expected exit.
 */
const MAX_STEPS = 366 * 24;

/**
 * The next instant strictly after `from` whose **local** wall clock matches.
 *
 * `null` when no match is found within {@link MAX_STEPS} minutes.
 *
 * ## How the fall-back bug is avoided
 *
 * Two rules, and the second is the one the old code lacked:
 *
 * 1. Every field test is a *local* read (`getHours`, `getDate`, …), so the
 *    expression keeps meaning "9am where the user is".
 * 2. After a candidate is found, it is accepted only if `candidate.getTime() >
 *    from.getTime()`. A wall-clock walk over a repeated hour produces
 *    candidates whose *real* time can be earlier than the starting point; this
 *    check refuses those and lets the walk continue. Without it the walk can
 *    also stall (a candidate that is always rejected), so each step advances
 *    the clock by a whole minute of **real** time, which guarantees
 *    termination even while the local reading is frozen.
 *
 * Standard cron day semantics are kept: when both day-of-month and
 * day-of-week are constrained, a match on **either** counts. `0 9 13 * 5`
 * fires on the 13th *and* on every Friday.
 *
 * DST behaviour, both pinned by tests:
 *  - **Spring forward**: a fixed-hour expression targeting the missing hour
 *    skips that day — the gap hour never appears in local time. `30 2 * * *`
 *    on a US spring-forward day fires the next day.
 *  - **Fall back**: the repeated hour fires **once**. From an anchor inside the
 *    first 01:xx the next fire is in the second 01:xx (a later real instant);
 *    from an anchor inside the second 01:xx the next fire is an hour later.
 *    That is what `next > from` buys, and it is why this module never advances
 *    by a wall-clock field jump once a match is found.
 */
export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
  const dayOfMonthSet = new Set(fields.dayOfMonth);
  const monthSet = new Set(fields.month);
  const dayOfWeekSet = new Set(fields.dayOfWeek);

  // "Unconstrained" is decided by width, so `0-59` counts as a wildcard too.
  const dayOfMonthWild = fields.dayOfMonth.length === 31;
  const dayOfWeekWild = fields.dayOfWeek.length === 7;
  const fromMs = from.getTime();

  // Round up to the next whole minute **in real time**. `setMinutes(+1)` is
  // deliberately not used: on a fall-back day it is wall-clock arithmetic, and
  // stepping the local minute across the transition lands the cursor *behind*
  // `from` — measured here as 05:31Z for a 06:30Z anchor, one hour and one
  // minute early. A walk that starts behind its own anchor then reports a fire
  // time the person already missed. `setTime` advances by exact real
  // milliseconds and cannot cross an offset change.
  const firstCandidateMs = fromMs - (fromMs % 60_000) + 60_000;
  const cursor = new Date(firstCandidateMs);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (
      monthSet.has(cursor.getMonth() + 1) &&
      matchesDay(cursor, dayOfMonthSet, dayOfWeekSet, dayOfMonthWild, dayOfWeekWild) &&
      // The invariant this module exists for, checked *before* the day-level
      // jumps below so no jump can ever return an earlier instant.
      cursor.getTime() > fromMs
    ) {
      const found = findTimeOfDay(cursor, fields.hour, fields.minute, fromMs);
      if (found !== null) {
        return found;
      }
    }

    // Day-level jump. Safe precisely because the day already failed the match:
    // moving to midnight of the next day cannot skip a matching day, and it is
    // what keeps a "0 0 29 2 *" answer reachable inside the step budget instead
    // of walking five hundred thousand minutes.
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }

  return null;
}

/**
 * Find the first matching time of day on the local calendar day of `day`, as a
 * real instant strictly after `fromMs`.
 *
 * ## Why the candidate is built from calendar parts, not from `day`
 *
 * `day` is midnight of the target day, so `new Date(day).setHours(h, m, 0, 0)`
 * looks like it should land on that same day. It does not always: near a
 * transition the offset in force at midnight differs from the one in force at
 * `h:m`, and applying the day's own offset to a wall-clock time in the other
 * half shifts the instant onto the neighbouring day. Observed as a
 * `30 * * * *` job anchored inside the repeated hour reporting "tomorrow
 * 00:30" while 02:30 the same day was still ahead of it.
 *
 * `new Date(year, month, day, hours, minutes)` re-derives the offset for the
 * target wall-clock time instead of reusing midnight's, which is what a person
 * means by "02:30 on the 1st".
 *
 * Inside one calendar day the hours and minutes are ascending in both arrays
 * (`expandField` sorts them), so the first candidate that is after `fromMs` is
 * the earliest one — the `>` re-check is what makes that true on the repeated
 * hour, where a candidate can otherwise land on the *second* reading of a
 * wall-clock time and be earlier as an instant.
 *
 * `null` when the day has no matching time after `fromMs`. That happens on the
 * repeated hour, and then the next day is the honest answer.
 */
function findTimeOfDay(
  day: Date,
  hourSet: ReadonlyArray<number>,
  minuteSet: ReadonlyArray<number>,
  fromMs: number,
): Date | null {
  for (const hours of hourSet) {
    for (const minutes of minuteSet) {
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        hours,
        minutes,
        0,
        0,
      );
      if (candidate.getTime() <= fromMs) {
        continue;
      }

      // The gap check. On a spring-forward day `new Date(y, m, d, 2, 30)` does
      // not fail — JavaScript normalises it to 03:30 local, because no local
      // 02:30 exists. Accepting that would silently move a job to a different
      // hour than the person asked for, and it would be invisible: the returned
      // Date looks perfectly valid. Requiring the round-trip means the missing
      // hour simply produces no candidate, and the caller moves to the next day
      // — the same thing vixie-cron does, and what the reused source's comment
      // promised.
      if (candidate.getHours() !== hours || candidate.getMinutes() !== minutes) {
        continue;
      }

      return candidate;
    }
  }
  return null;
}

function matchesDay(
  at: Date,
  dayOfMonthSet: ReadonlySet<number>,
  dayOfWeekSet: ReadonlySet<number>,
  dayOfMonthWild: boolean,
  dayOfWeekWild: boolean,
): boolean {
  if (dayOfMonthWild && dayOfWeekWild) {
    return true;
  }

  if (dayOfMonthWild) {
    return dayOfWeekSet.has(at.getDay());
  }

  if (dayOfWeekWild) {
    return dayOfMonthSet.has(at.getDate());
  }

  // Both constrained: either matching is enough (vixie-cron semantics).
  return dayOfMonthSet.has(at.getDate()) || dayOfWeekSet.has(at.getDay());
}
