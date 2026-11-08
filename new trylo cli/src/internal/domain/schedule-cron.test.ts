import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { computeNextCronRun, parseCronExpression } from "./schedule-cron.js";
import { cronToHuman } from "./schedule-cron-human.js";

/**
 * Cron arithmetic regressions (WP26 / A06).
 *
 * The DST case below is not a hypothetical. The WP26 review measured the
 * reused algorithm on America/New_York and found it returning a fire time
 * **59 minutes before** its own anchor; see
 * `evidence/2026-10-07-WP26-review/cron-boundary-results.json` (source
 * SHA-256 `e8ba70b3…`). It is kept here as a permanent regression because the
 * failure is silent in normal use — the task simply runs early, once.
 *
 * Timezone-sensitive cases cannot run in the test process: the runner's zone
 * is whatever the machine has. They are executed in a child with `TZ` pinned,
 * which is also what makes them reproducible on a machine that has never seen
 * a DST transition.
 */

function nextIn(zone: string, expression: string, fromIso: string): Date | null {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const url = new URL(${JSON.stringify(new URL("./schedule-cron.js", import.meta.url).href)});
      import(url.href).then((m) => {
        const fields = m.parseCronExpression(${JSON.stringify(expression)});
        if (fields === null) { console.log("PARSE_NULL"); return; }
        const next = m.computeNextCronRun(fields, new Date(${JSON.stringify(fromIso)}));
        console.log(next === null ? "NULL" : String(next.getTime()));
      });
      `,
    ],
    { env: { ...process.env, TZ: zone }, encoding: "utf-8", timeout: 20_000 },
  );
  if (child.status !== 0) {
    throw new Error(`cron child failed (${zone}): ${child.stderr}`);
  }

  const line = child.stdout.trim();

  assert.notEqual(line, "PARSE_NULL", `${expression} failed to parse in ${zone}`);

  return line === "NULL" ? null : new Date(Number(line));
}

test("invalid expressions are refused rather than approximated", () => {
  for (const input of [
    "bogus",
    "* * * *", // 4 fields
    "* * * * * *", // 6 fields
    "60 * * * *", // minute out of range
    "* 24 * * *", // hour out of range
    "0 0 32 * *", // day out of range
    "0 0 * 13 *", // month out of range
    "* * * * 8", // weekday out of range
    "*/0 * * * *", // step of zero
    "5-1 * * * *", // inverted range
    "*/ * * * *", // unparseable step
  ]) {
    assert.equal(parseCronExpression(input), null, `${input} should not parse`);
  }
});

test("valid expressions parse and expand to sorted value lists", () => {
  const fields = parseCronExpression("*/15 9-17 * * 1-5");
  assert.deepEqual(fields?.minute, [0, 15, 30, 45]);
  assert.deepEqual(fields?.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  // 0=Sunday, so 1-5 is Monday..Friday.
  assert.deepEqual(fields?.dayOfWeek, [1, 2, 3, 4, 5]);
});

test("7 is accepted as a Sunday alias in both forms", () => {
  assert.deepEqual(parseCronExpression("0 0 * * 7")?.dayOfWeek, [0]);
  assert.deepEqual(parseCronExpression("0 0 * * 5-7")?.dayOfWeek, [0, 5, 6]);
});

test("next run is always strictly after the anchor", () => {
  const base = Date.parse("2026-10-06T00:00:00Z");
  for (const expression of ["*/5 * * * *", "0 9 * * *", "0 0 1 1 *", "30 14 28 2 *"]) {
    const fields = parseCronExpression(expression);

    assert.ok(fields !== null, `${expression} must parse`);

    for (const offset of [0, 60_000, 3_600_000]) {
      const from = new Date(base + offset);
      const next = computeNextCronRun(fields, from);

      assert.ok(next !== null, `${expression} must have a next run`);
      assert.ok(
        next.getTime() > from.getTime(),
        `${expression} from ${from.toISOString()} produced ${next.toISOString()}, which is not later`,
      );
    }
  }
});

test("day-of-month and day-of-week both constrained means either match", () => {
  // The 13th of a month *and* every Friday.
  const fields = parseCronExpression("0 9 13 * 5");

  assert.ok(fields !== null, "0 9 13 * 5 must parse");
  const first = computeNextCronRun(fields, new Date("2026-10-01T00:00:00Z"));

  assert.ok(first !== null);
  const isThirteenth = first.getDate() === 13;
  const isFriday = first.getDay() === 5;

  assert.ok(isThirteenth || isFriday, `${first.toISOString()} matches neither constraint`);
});

test("a leap day is reachable from a non-leap year", () => {
  const next = nextIn("UTC", "0 0 29 2 *", "2026-10-06T00:00:00Z");
  assert.ok(next !== null, "a leap day must be reachable, not merely not-found");
  assert.equal(next.getUTCFullYear(), 2028);
  assert.equal(next.getUTCMonth(), 1);
  assert.equal(next.getUTCDate(), 29);
});

test("DST spring gap: a job targeting the missing hour skips that day", () => {
  // 2026-03-08 America/New_York has no 02:30 local.
  const next = nextIn("America/New_York", "30 2 * * *", "2026-03-08T01:59:00-05:00");
  assert.ok(next !== null, "the gap hour must not swallow the schedule");
  assert.equal(next.toISOString(), "2026-03-09T06:30:00.000Z");
});

test("DST fall-back: next run from the second repeated hour is still later in real time", () => {
  // 2026-11-01 America/New_York reads 01:00-01:59 twice. The anchor is the
  // *second* 01:10 (EST). The reused algorithm answered 01:11 EDT — one hour
  // earlier than where it started — which would fire the job before it was due
  // and could re-arm on an earlier instant indefinitely.
  const from = Date.parse("2026-11-01T01:10:00-05:00");
  const next = nextIn("America/New_York", "* * * * *", new Date(from).toISOString());

  assert.ok(next !== null, "there must be a next run inside the repeated hour");
  assert.ok(
    next.getTime() > from,
    `next=${next.toISOString()} is not after from=${new Date(from).toISOString()}`,
  );
});

test("DST fall-back: next run from the first repeated hour advances by one real minute", () => {
  // The *first* 01:10 is EDT (-04:00). One minute later is 01:11 EDT, a later
  // real instant. The step has to be exact: a wall-clock setter inside the
  // repeated hour advances the reading by an hour instead.
  const from = Date.parse("2026-11-01T01:10:00-04:00");
  const next = nextIn("America/New_York", "* * * * *", new Date(from).toISOString());

  assert.ok(next !== null);
  assert.ok(next.getTime() > from, `next=${next.toISOString()} is not after from=${new Date(from).toISOString()}`);
  assert.equal(next.getTime() - from, 60_000);
  assert.equal(next.toISOString(), "2026-11-01T05:11:00.000Z");
});

test("DST fall-back: the repeated hour fires once, so the second pass moves on", () => {
  // Inside the *second* 01:xx every remaining matching minute of that
  // wall-clock hour is already past, so the honest next fire for an
  // every-minute job is 02:00 — not another pass through 01:xx. This is what
  // "fires once" means, and it falls out of the strictly-after rule rather than
  // being a special case.
  const from = Date.parse("2026-11-01T01:30:00-05:00");
  const next = nextIn("America/New_York", "* * * * *", new Date(from).toISOString());

  assert.ok(next !== null);
  assert.ok(next.getTime() > from);
  assert.equal(next.toISOString(), "2026-11-01T07:00:00.000Z");
});

test("DST fall-back: a coarser expression still sees the rest of the same day", () => {
  // "30 * * * *" from the second 01:30 has 02:30 the same day still ahead of
  // it. An implementation that starts its walk behind the anchor — which is what
  // wall-clock "add one minute" produces on this date — skips the whole day.
  const from = Date.parse("2026-11-01T01:30:00-05:00");
  const next = nextIn("America/New_York", "30 * * * *", new Date(from).toISOString());

  assert.ok(next !== null);
  assert.equal(next.toISOString(), "2026-11-01T07:30:00.000Z");
  assert.equal(next.getTime() - from, 60 * 60_000);
});

test("DST fall-back: an hourly job anchored after its hour moves to tomorrow", () => {
  // "0 1 * * *" from 01:30 means 01:00, already past today; the next match is
  // tomorrow's. Stated so the day rollover is an expectation, not a surprise.
  const from = Date.parse("2026-11-01T01:30:00-05:00");
  const next = nextIn("America/New_York", "0 1 * * *", new Date(from).toISOString());
  assert.ok(next !== null);
  assert.equal(next.toISOString(), "2026-11-02T06:00:00.000Z");
});

test("DST fall-back: from the last minute of the first hour, 61 real minutes elapse", () => {
  // 01:59 EDT to 02:00 EST: the wall clock advances an hour while real time
  // advances 61 minutes. A scheduler assuming the two move together would sit
  // idle for the extra minute.
  const from = Date.parse("2026-11-01T01:59:00-04:00");
  const next = nextIn("America/New_York", "* * * * *", new Date(from).toISOString());

  assert.ok(next !== null);
  assert.equal(next.toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(next.getTime() - from, 61 * 60_000);
});

test("DST fall-back: a wildcard-hour job does not stall across the transition", () => {
  // The failure this guards is a scheduler whose next-fire computation cannot
  // advance while the local clock stands still: the task would hang for the
  // repeated hour and then fire in a burst.
  const from = Date.parse("2026-11-01T01:30:00-05:00");
  const next = nextIn("America/New_York", "30 * * * *", new Date(from).toISOString());

  assert.ok(next !== null, "a wildcard-hour job must not stall across the transition");
  assert.ok(next.getTime() > from);
  assert.equal(next.toISOString(), "2026-11-01T07:30:00.000Z");
});

test("human rendering covers the common patterns and falls through otherwise", () => {
  assert.equal(cronToHuman("*/5 * * * *"), "Every 5 minutes");
  assert.equal(cronToHuman("* * * * *"), "Every minute");
  assert.equal(cronToHuman("0 * * * *"), "Every hour");
  assert.equal(cronToHuman("*/2 * * * *"), "Every 2 minutes");
  assert.equal(cronToHuman("30 */3 * * *"), "Every 3 hours at :30");
  assert.equal(cronToHuman("0 9 * * 1-5"), "Weekdays at 9:00 AM");
  assert.equal(cronToHuman("0 9 * * 3"), "Every Wednesday at 9:00 AM");
  // Anything outside the narrow set is shown verbatim, never guessed at.
  assert.equal(cronToHuman("30 14 28 2 *"), "30 14 28 2 *");
  assert.equal(cronToHuman("not a cron"), "not a cron");
});
