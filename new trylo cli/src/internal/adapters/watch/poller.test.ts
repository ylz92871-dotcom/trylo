import assert from "node:assert/strict";
import test from "node:test";

import { pollWatches, type WatchPollResult } from "./poller.js";
import { watchOccurrenceId, type ConditionProbe, type WatchCondition } from "../../domain/watch.js";
import type { WatchClock, WatchId, WatchRow, WatchTrigger } from "../../ports/watch.js";
import type { Occurrence } from "../../ports/schedule.js";

/**
 * Polling armed watches (WP26 / A07).
 *
 * The claim worth proving is the **burst**: a condition that stays true across
 * many ticks must produce one message, not one per tick. These cases hold the
 * condition true deliberately and count what came out — a poller that only ever
 * sees a condition flipping once would pass every other test here.
 */

const T0 = new Date(2026, 9, 7, 0, 0, 0, 0).getTime();

/**
 * Mutable on  only.
 *
 * The store's port is read-only, but this fixture stands in for the *store*, and
 * a store that could not change a watch's state would not be a store. Everything
 * else stays readonly because nothing else here should be able to change it.
 */
type Watch = {
  readonly id: WatchId;
  readonly trigger: WatchTrigger;
  readonly text: string;
  readonly sessionId: string;
  state: WatchRow["state"];
};

type Lab = {
  readonly poll: (nowMs: number) => Promise<WatchPollResult>;
  readonly enqueued: Array<{ readonly sessionId: string; readonly text: string }>;
  readonly occurrences: Array<Occurrence>;
  readonly setCondition: (met: boolean) => void;
  readonly failStore: (fail: boolean) => void;
  readonly arm: (input: { trigger: WatchTrigger; text: string; sessionId?: string }) => WatchId;
  readonly find: (watchId: WatchId) => Watch | undefined;
};

function lab(watches: Watch[] = []): Lab {
  let met = false;
  let storeFails = false;
  const enqueued: Array<{ sessionId: string; text: string }> = [];
  const occurrences: Array<Occurrence> = [];
  let ids = 0;
  let clock = T0;

  const probe: ConditionProbe = {
    fileExists: () => met,
    fileContains: () => met,
    lastExitCode: () => (met ? 0 : undefined),
    flagSet: () => met,
  };
  const watchClock: WatchClock = { now: () => clock, newWatchId: () => `w${++ids}` };

  return {
    enqueued,
    occurrences,
    setCondition: (next) => {
      met = next;
    },
    failStore: (fail) => {
      storeFails = fail;
    },
    arm: (input) => {
      const id = watchClock.newWatchId();
      const createdAtMs = clock;
      const fireAtMs = input.trigger.kind === "deadline" ? input.trigger.atMs : createdAtMs;

      watches.push({
        id,
        trigger: input.trigger,
        text: input.text,
        sessionId: input.sessionId ?? "s-1",
        state: { state: "armed", watchId: id, fireAtMs },
      });

      return id;
    },
    find: (watchId) => watches.find((row) => row.id === watchId),
    poll: async (nowMs) => {
      clock = nowMs;
      return pollWatches(
        {
          watches: {
            list: async () =>
              storeFails
                ? { ok: false as const, code: "watch_unwritable" as const, message: "the record is gone" }
                : {
                    ok: true as const,
                    value: watches.map((row) => ({
                      id: row.id,
                      trigger: row.trigger,
                      state: row.state,
                      text: row.text,
                      sessionId: row.sessionId,
                      createdAtMs: T0,
                    })),
                  },
            evaluate: async (watchId) => {
              const row = watches.find((candidate) => candidate.id === watchId);
              if (row === undefined) {
                return { ok: false as const, code: "watch_not_found" as const, message: "gone" };
              }

              if (row.trigger.kind === "deadline") {
                const due = nowMs >= row.trigger.atMs;
                return {
                  ok: true as const,
                  value: due ? { met: true, because: "the moment arrived" } : { met: false },
                };
              }

              const verdict = probe.fileExists("x");

              return { ok: true as const, value: verdict ? { met: true, because: "x exists" } : { met: false } };
            },
            fire: async (watchId, atMs, messageId) => {
              const row = watches.find((candidate) => candidate.id === watchId);
              if (row === undefined) {
                return { ok: false as const, code: "watch_not_found" as const, message: "gone" };
              }
              row.state = { state: "fired", watchId, firedAtMs: atMs, messageId };
              return { ok: true as const, value: row.state };
            },
            create: async () => ({ ok: false as const, code: "watch_unwritable" as const, message: "unused in this case" }),
            createOrFire: async () => ({ ok: false as const, code: "watch_unwritable" as const, message: "unused" }),
            cancel: async () => ({ ok: false as const, code: "watch_not_found" as const, message: "unused" }),
            settled: async () => ({ ok: true as const, value: [] }),
            forget: async () => ({ ok: false as const, code: "watch_not_found" as const, message: "unused" }),
          },
          enqueue: async (sessionId, text) => {
            enqueued.push({ sessionId, text });
            return `msg-${enqueued.length}`;
          },
          occurrences: async () => occurrences,
          maxFiresPerPass: 5,
        },
        nowMs,
      );
    },
  };
}

const CONDITION: WatchCondition = { kind: "file_exists", relativePath: "build.txt" };

test("a condition that is not met leaves the watch alone", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.setCondition(false);
  h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "build done" });

  const result = await h.poll(T0 + 1_000);

  assert.equal(result.fired.length, 0);
  assert.equal(result.examined, 1);
  // And nothing was queued, so there is no message to retract.
  assert.equal(h.enqueued.length, 0);
});

test("a condition that is met fires once and says what it saw", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.setCondition(true);
  const id = h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "build done" });

  const result = await h.poll(T0 + 1_000);

  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0]?.watchId, id);
  assert.equal(h.enqueued.length, 1);
  // The message says why, before what — a notification with no explanation is
  // indistinguishable from a broken one.
  assert.match(h.enqueued[0]?.text ?? "", /^watch .*: .*exists\n/);
  assert.match(h.enqueued[0]?.text ?? "", /build done/);
});

test("a condition that stays true does not fire again — the burst case", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.setCondition(true);
  h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "build done" });

  // The first tick notices it.
  const first = await h.poll(T0 + 1_000);

  assert.equal(first.fired.length, 1);
  h.occurrences.push(occurrenceFor((first.fired[0]?.watchId) as WatchId, T0));

  // The condition is **still true**. Every later tick must not fire.
  h.setCondition(true);

  for (let tick = 2; tick <= 10; tick += 1) {
    const later = await h.poll(T0 + tick * 1_000);
    assert.equal(later.fired.length, 0, `tick ${tick} must not fire again`);
  }

  // Nine extra evaluations, one message. That is the whole design.
  assert.equal(h.enqueued.length, 1);
});

test("a watch left armed whose occurrence is recorded does not fire — the crash case", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.setCondition(true);
  const id = h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "build done" });

  // The crash between "fired" and "wrote the row": the occurrence is on record,
  // the row still says armed.
  // Derived from the watch, not from the tick that noticed it — see
  // `watchFireMoment` for why the difference matters.
  h.occurrences.push(occurrenceFor(id, T0));

  const result = await h.poll(T0 + 1_000);

  assert.equal(result.fired.length, 0, "an already-recorded fire must not produce a message");
  // And it is counted as skipped, so a watch that never settles is visible.
  assert.equal(result.skippedAlreadyFired, 1);
  assert.equal(h.enqueued.length, 0);
});

test("a deadline fires once its moment passes", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.arm({ trigger: { kind: "deadline", atMs: T0 + 5_000 }, text: "reminder" });

  // Before: nothing.
  const early = await h.poll(T0 + 1_000);

  assert.equal(early.fired.length, 0);

  // After: fires. And the occurrence is derived from the deadline, not from the
  // poll, so a restart re-derives the same id.
  const due = await h.poll(T0 + 6_000);

  assert.equal(due.fired.length, 1);
  h.occurrences.push(occurrenceFor((due.fired[0]?.watchId) as WatchId, T0 + 5_000));  // a deadline names its own moment
  assert.match(h.enqueued[0]?.text ?? "", /the moment arrived/);

  // And again does not re-fire, because the deadline id is stable.
  const later = await h.poll(T0 + 7_000);

  assert.equal(later.fired.length, 0);
});

test("two watches on the same condition both fire once", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.setCondition(true);
  h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "first" });
  h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "second" });

  const result = await h.poll(T0 + 1_000);

  // Deduplication is per watch, not per condition: two watches are two promises.
  assert.equal(result.fired.length, 2);
  assert.equal(h.enqueued.length, 2);
});

test("one pass is bounded, and the rest wait for the next tick", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.setCondition(true);

  for (let index = 0; index < 8; index += 1) {
    h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: `watch ${index}` });
  }

  const first = await h.poll(T0 + 1_000);

  // The poller's own cap, so a hundred armed watches cannot make one pass unbounded.
  assert.equal(first.fired.length, 5);
  assert.equal(first.examined, 8);
  // And the remainder is not lost: a later pass picks up the ones still armed.
  const second = await h.poll(T0 + 2_000);

  assert.equal(second.fired.length, 3);
});

test("a store that cannot be read fires nothing and does not claim a clean pass", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);

  h.setCondition(true);
  h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "build done" });
  h.failStore(true);

  const result = await h.poll(T0 + 1_000);

  // Silence here would read as "no conditions met" rather than "I cannot tell".
  assert.equal(result.fired.length, 0);
  assert.equal(result.examined, 0);
  assert.equal(h.enqueued.length, 0);
});

test("a terminal watch is not examined again", async () => {
  const watches: Watch[] = [];
  const h = lab(watches);
  const id = h.arm({ trigger: { kind: "condition", condition: CONDITION }, text: "build done" });
  const row = watches[0] as Watch;

  row.state = { state: "cancelled", watchId: id, cancelledAtMs: T0, reason: "not needed" };
  h.setCondition(true);

  const result = await h.poll(T0 + 1_000);

  assert.equal(result.examined, 0);
  assert.equal(h.enqueued.length, 0);
});

/**
 * The occurrence a scheduler would record for a fired watch.
 *
 * `atMs` must be the watch's own moment — its `createdAtMs`, or its deadline —
 * because that is what {@link watchFireMoment} derives. Passing the poll's clock
 * instead would make this fixture disagree with the code under test and the case
 * would fail for a reason that has nothing to do with deduplication.
 */
function occurrenceFor(watchId: WatchId, atMs: number): Occurrence {
  return {
    id: watchOccurrenceId(watchId, atMs),
    scheduleId: `watch_${watchId}`,
    dueAtMs: atMs,
    state: { state: "completed", attemptId: "att_1", completedAtMs: atMs, result: {} },
    prompt: "p",
    delivery: "queue",
  };
}
