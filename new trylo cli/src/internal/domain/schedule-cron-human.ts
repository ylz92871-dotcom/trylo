/**
 * Describing a cron expression in words (WP26 / A06).
 *
 * Split out of `schedule-cron.ts` under the file-size gate, and split on
 * purpose rather than for tidiness: parsing and next-run computation are
 * **arithmetic**, this is **presentation**. They have different readers — one
 * is a scheduler that must be right, the other is a person deciding whether
 * the job they just created is the one they meant — and a change to the
 * wording must never be able to alter when a task fires.
 *
 * Mechanical reuse of old CLI `src/utils/cron.ts` (the `cronToHuman` half).
 * Coverage is deliberately narrow: a scheduler that mis-describes a job is
 * worse than one that shows the expression, because the person reads the
 * description and stops looking at the expression.
 */

/** Weekday names, indexed so `0` is Sunday — matching `getDay()`. */
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MINUTE_ONLY = /^(\d+)$/;
const EVERY_N_MINUTES = /^\*\/(\d+)$/;
const EVERY_N_HOURS = /^\*\/(\d+)$/;
const SINGLE_DIGIT = /^\d$/;

/**
 * Render an expression the way a person would say it, falling through to the
 * raw string for anything this does not cover.
 *
 * `utc` exists for schedules the **server** evaluates: those expressions are
 * written in UTC, so the weekday has to be re-derived from the UTC instant —
 * midnight UTC is not midnight in most of the world, and showing "Sunday" for
 * a job that fires on Monday local time is how a reminder lands a day off.
 */
export function cronToHuman(cron: string, options?: { readonly utc?: boolean }): string {
  const utc = options?.utc ?? false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return cron;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const allWild = dayOfMonth === "*" && month === "*" && dayOfWeek === "*";

  // `*` alone does not match `^\*\/(\d+)$` (the slash is required), so
  // "every minute" needs its own case. Without it `* * * * *` would fall all
  // the way through to the raw expression — the one schedule people read most.
  if (minute === "*" && hour === "*" && allWild) {
    return "Every minute";
  }

  const everyMinutes = minute.match(EVERY_N_MINUTES);
  if (everyMinutes !== null && hour === "*" && allWild) {
    const count = Number.parseInt(everyMinutes[1] as string, 10);
    return count === 1 ? "Every minute" : `Every ${count} minutes`;
  }

  const everyHours = hour.match(EVERY_N_HOURS);
  if (everyHours !== null && minute.match(MINUTE_ONLY) !== null && allWild) {
    const count = Number.parseInt(everyHours[1] as string, 10);
    const at = minute === "0" ? "" : ` at :${minute.padStart(2, "0")}`;
    return count === 1 ? `Every hour${at}` : `Every ${count} hours${at}`;
  }

  if (minute.match(MINUTE_ONLY) !== null && hour === "*" && allWild) {
    return minute === "0" ? "Every hour" : `Every hour at :${minute.padStart(2, "0")}`;
  }

  if (minute.match(MINUTE_ONLY) === null || hour.match(MINUTE_ONLY) === null) {
    return cron;
  }

  const minutes = Number.parseInt(minute, 10);
  const hours = Number.parseInt(hour, 10);
  const time = utc ? formatUtcAsLocal(hours, minutes) : formatLocalTime(hours, minutes);

  if (allWild) {
    return `Every day at ${time}`;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
    return `Weekdays at ${time}`;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek.match(SINGLE_DIGIT) !== null) {
    const name = DAYS[Number.parseInt(dayOfWeek, 10) % 7];
    return `Every ${name} at ${time}`;
  }

  return cron;
}

/**
 * Format a local wall-clock time.
 *
 * The date is pinned to 2000-01-01 because that day has no DST transition
 * anywhere. Building it from "now" would roll 02:00 to 03:00 on the one
 * spring-forward day each year and describe a job that never runs.
 */
function formatLocalTime(hours: number, minutes: number): string {
  const at = new Date(2000, 0, 1, hours, minutes);
  return at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatUtcAsLocal(hours: number, minutes: number): string {
  const at = new Date();

  at.setUTCHours(hours, minutes, 0, 0);

  return at.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
