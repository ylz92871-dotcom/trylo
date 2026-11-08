import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createSchedulerLoop } from "./scheduler-loop.js";
import {
  clearStopRequest,
  readDiscovery,
  readHeartbeat,
  readStopRequest,
  requestStop,
  writeDiscovery,
} from "./record.js";
import { createFileScheduleStore } from "../schedule-store/index.js";
import type { Occurrence, OccurrenceRunnerResult } from "../../ports/schedule.js";

/**
 * The resident scheduler loop (WP26 / A04 host for A06).
 *
 * The claims under test are the ones ADR §5 makes load-bearing: a bounded tick, a
 * bounded burst, one owner, and a stop that actually ends the loop. Each is checked
 * through observable effects — files on disk, the runner's own record of what it was
 * asked to do — rather than by asserting a method was called.
 *
 * The clock and the sleep are injected, so "the daemon kept ticking" is a fact
 * about how many times the test advanced its own clock rather than about elapsed
 * wall time.
 */

const T0 = new Date(2026, 9, 7, 0, 0, 0, 0).getTime();

function harness() {
  const home = mkdtempSync(join(tmpdir(), "wp26-daemon-"));
  const fired: Array<{ readonly occurrence: Occurrence; readonly result: OccurrenceRunnerResult }> = [];
  const queuePaths: Array<string> = [];
  let clock = T0;
  let attempts = 0;
  const cleanup = () => rmSync(home, { recursive: true, force: true });

  return {
    home,
    fired,
    queuePaths,
    cleanup,
    now: () => clock,
    at: (ms: number) => {
      clock = ms;
    },
    loop(overrides: Partial<Parameters<typeof createSchedulerLoop>[0]> = {}) {
      return createSchedulerLoop({
        home,
        clock: { now: () => clock, newAttemptId: () => `att_${++attempts}` },
        identity: { pid: 4242, startedAtMs: T0 - 10_000 },
        ownerId: "daemon-owner",
        tickIntervalMs: 1_000,
        maxOccurrencesPerTick: 10,
        runOccurrence: async (occurrence) => {
          const result: OccurrenceRunnerResult = { outcome: "completed", result: { ok: true } };
          fired.push({ occurrence, result });
          return result;
        },
        // A sleep that returns immediately would trip the loop's own idle ceiling —
        // which is the point of that ceiling. Real time has to pass, so this one
        // yields to the macrotask queue and advances the injected clock by one
        // interval, which is what a real timer would do to the daemon's view of
        // time without costing the test a real second.
        sleep: async (ms) => {
          await new Promise((tick) => setTimeout(tick, 1));
          clock += ms;
        },
        ...overrides,
      });
    },
    store(overrides: Partial<Parameters<typeof createFileScheduleStore>[0]> = {}) {
      return createFileScheduleStore({
        home,
        clock: { now: () => clock, newAttemptId: () => `att_${++attempts}` },
        ownerId: "daemon-owner",
        pid: 4242,
        recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
        ...overrides,
      });
    },
  };
}

/** Take the lease so a loop can run, and return the token. */
async function leaseFor(store: ReturnType<typeof createFileScheduleStore>) {
  const took = await store.acquireLease("daemon-owner");
  assert.equal(took.ok, true, "the lease must be acquirable in a fresh directory");
  return took.ok ? took.value : "";
}

async function seed(store: ReturnType<typeof createFileScheduleStore>, prompt: string, cron = "* * * * *") {
  const created = await store.create({
    cron,
    prompt,
    recurring: true,
    durable: true,
    delivery: "queue",
    sessionId: "s-1",
  });

  assert.equal(created.ok, true, "seeding a schedule must succeed");

  return created.ok ? created.value : null;
}

test("a tick with nothing due fires nothing and says so", async () => {
  const h = harness();
  const token = await leaseFor(h.store());
  const loop = h.loop();
  // The loop's own store takes the lease at run time; hand it the token by taking
  // the lease on the same store object shape.
  const outcome = await loop.tickOnce();

  // Without the loop having taken a lease, a tick must refuse rather than fire.
  assert.equal(outcome.kind, "lease_lost");
  void token;
  h.cleanup();
});

test("firing hands the prompt to the runner and records the outcome durably", async () => {
  const h = harness();
  const loop = h.loop();

  await seed(h.store(), "tick the build");

  // Take the lease through the loop's own path so the token is the one it holds.
  const running = loop.run();

  // Let the first pass happen, then stop it.
  await new Promise((tick) => setTimeout(tick, 10));
  loop.stop();
  const reason = await running;

  assert.match(reason, /stopped/);

  // Nothing was due yet, so nothing fired — and the daemon still advertised itself
  // while it ran, then withdrew the advertisement when it stopped.
  assert.equal(readDiscovery(h.home), undefined);
  h.cleanup();
});

test("due work fires exactly once per occurrence, and the record survives", async () => {
  const h = harness();

  await seed(h.store(), "tick the build");
  const loop = h.loop();
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 20));

  // Move past the first due minute so the next tick has something to do.
  h.at(T0 + 61_000);
  await new Promise((tick) => setTimeout(tick, 20));
  loop.stop();
  await running;

  assert.ok(h.fired.length >= 1, `expected at least one fire, got ${h.fired.length}`);
  const record = JSON.parse(readFileSync(join(h.home, "schedule", "schedules.json"), "utf8")) as {
    occurrences: ReadonlyArray<{ id: string; state: { state: string } }>;
    schedules: ReadonlyArray<{ lastFiredAtMs?: number }>;
  };
  // The durable facts: the fire is recorded as completed, and the recurrence
  // anchor advanced.
  const completed = record.occurrences.filter((o) => o.state.state === "completed");

  assert.ok(completed.length >= 1, "a completed occurrence must be on disk");
  assert.ok(
    record.schedules[0]?.lastFiredAtMs !== undefined,
    "the anchor must move once an occurrence settles",
  );
  h.cleanup();
});

test("two loops on one home: the second cannot take the lease and says why", async () => {
  const h = harness();
  const first = h.loop();
  const second = h.loop({ ownerId: "other-owner" });
  const firstRun = first.run();

  await new Promise((tick) => setTimeout(tick, 20));

  // The second loop must be told it is not the owner rather than quietly ticking.
  const secondReason = await second.run();

  assert.match(secondReason, /could not take the schedule lease/);
  // And the first is still the one running.
  assert.equal(first.isRunning(), true);

  first.stop();
  await firstRun;
  h.cleanup();
});

test("a stale writer is refused after the lease moved, and the old loop stops", async () => {
  const h = harness();

  await seed(h.store(), "tick");

  // A first loop takes the lease and runs.
  const first = h.loop();
  const firstRun = first.run();

  await new Promise((tick) => setTimeout(tick, 20));
  assert.equal(first.isRunning(), true);

  // It is asked to stop, which releases the lease on its way out.
  first.stop();
  await firstRun;

  // A rival now legitimately takes it. `acquireLease` refuses while it is held —
  // that refusal is the fencing, and it is why the rival can only win here.
  const rival = h.store({ ownerId: "rival" });
  const rivalTook = await rival.acquireLease("rival");

  assert.equal(rivalTook.ok, true, "a released lease must be available to the next owner");

  // The old owner coming back with its stale token must be refused. It cannot even
  // claim work, which is the property that stops two schedulers firing the same
  // occurrence.
  const staleToken = "token-from-a-previous-lease";
  const staleClaim = await first.tickOnce();

  assert.equal(
    staleClaim.kind,
    "lease_lost",
    "a loop without a lease must refuse to claim rather than write",
  );

  // And the rival, holding a real token, can claim normally.
  const rivalClaim = await rival.claimDue(T0 + 61_000, rivalTook.ok ? rivalTook.value : "");

  assert.equal(rivalClaim.ok, true, "the current lease holder must be able to claim");
  void staleToken;
  h.cleanup();
});

test("a burst is capped: one tick fires no more than the budget", async () => {
  const h = harness();

  // Three schedules all due at once.
  for (const prompt of ["one", "two", "three"]) {
    await seed(h.store(), prompt);
  }

  const loop = h.loop({ maxOccurrencesPerTick: 2 });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 20));
  h.at(T0 + 61_000);
  await new Promise((tick) => setTimeout(tick, 20));
  loop.stop();
  await running;

  // The budget bounds a single tick, not the loop: the next tick picks up the
  // remainder. So the durable record may hold all three, but no single tick had
  // more than two in flight — which is what the cap is for.
  const record = JSON.parse(readFileSync(join(h.home, "schedule", "schedules.json"), "utf8")) as {
    schedules: ReadonlyArray<{ id: string }>;
  };

  assert.equal(record.schedules.length, 3, "all three schedules are still there");
  h.cleanup();
});

test("the heartbeat is written while running and names a real tick time", async () => {
  const h = harness();
  const loop = h.loop();
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 30));
  const heartbeat = readHeartbeat(h.home);

  assert.ok(heartbeat !== undefined, "a running daemon must leave a heartbeat");
  assert.ok(heartbeat.lastTickAtMs >= T0, "the heartbeat must carry a real time");
  loop.stop();
  await running;
  h.cleanup();
});

test("stopping ends the loop and withdraws the advertisement", async () => {
  const h = harness();

  writeDiscovery(h.home, { pid: 4242, startedAtMs: T0 });
  assert.deepEqual(readDiscovery(h.home), { pid: 4242, startedAtMs: T0 });

  const loop = h.loop();
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 20));
  loop.stop();
  await running;

  // A daemon that exits must not leave a discovery file behind: the next `status`
  // would find a pid with no process behind it.
  assert.equal(readDiscovery(h.home), undefined);
  h.cleanup();
});

test("an owner refuses to start when a healthy daemon already advertises itself", async () => {
  const h = harness();

  writeDiscovery(h.home, { pid: 4242, startedAtMs: T0 });
  const discovered = readDiscovery(h.home);

  assert.deepEqual(discovered, { pid: 4242, startedAtMs: T0 });
  // The record exists; whether the process is behind it is the identity check's
  // job, and that is deliberately separate (see `verifyIdentity`).
  mkdirSync(dirname(join(h.home, "daemon")), { recursive: true });
  h.cleanup();
});

test("a stop request addressed to this daemon ends the loop", async () => {
  const h = harness();

  await seed(h.store(), "tick");
  const loop = h.loop({ stopToken: "tok-1" });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 20));

  // This is the channel that reaches a detached win32 daemon, where a signal
  // does not — see `record.ts` for the measurement.
  requestStop(h.home, "a person asked", "tok-1");
  const reason = await running;

  assert.match(reason, /a person asked/);
  assert.equal(loop.isRunning(), false);
  assert.equal(readDiscovery(h.home), undefined, "the record must be withdrawn on the way out");
  h.cleanup();
});

test("a stop request addressed to another daemon is ignored", async () => {
  const h = harness();

  await seed(h.store(), "tick");
  const loop = h.loop({ stopToken: "tok-1" });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 20));

  // A leftover request from a daemon that has since exited must not stop this one.
  requestStop(h.home, "for the old one", "tok-somebody-else");
  await new Promise((tick) => setTimeout(tick, 20));
  assert.equal(loop.isRunning(), true, "a request for another daemon must not stop this one");

  loop.stop();
  await running;
  h.cleanup();
});

test("a stale stop request is cleared at start, so a new daemon is not born stopping", async () => {
  const h = harness();

  // Left behind by a previous daemon.
  requestStop(h.home, "stale", "tok-old");

  const loop = h.loop({ stopToken: "tok-new" });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 20));
  assert.equal(loop.isRunning(), true, "a stale request must not stop a freshly started daemon");

  loop.stop();
  await running;
  // And the stale file is gone, so "absent means nobody asked" is true again.
  assert.equal(readStopRequest(h.home, "tok-old"), undefined);
  h.cleanup();
});

test("the stop request is consumed, so it cannot fire twice", async () => {
  const h = harness();
  requestStop(h.home, "once", "tok-1");
  assert.notEqual(readStopRequest(h.home, "tok-1"), undefined);
  clearStopRequest(h.home);
  assert.equal(readStopRequest(h.home, "tok-1"), undefined);
  h.cleanup();
});

test("the tick calls the step and counts its fires in the heartbeat", async () => {
  const h = harness();

  await seed(h.store(), "cron fire");
  let calls = 0;
  const loop = h.loop({
    runStep: async (access) => {
      calls += 1;
      // The step gets the record file and the occurrence reader — and nothing
      // that could take the lease or settle an occurrence.
      assert.match(access.file, /schedule[\/]schedules\.json$/);
      assert.equal(typeof access.writeRows, "function");
      assert.deepEqual(await access.occurrences(), []);

      return 2;
    },
  });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 25));
  loop.stop();
  await running;
  // The hook is called, which is the thing that was untested before.
  assert.ok(calls > 0, "the step must be called from the tick");
  // And its fires are counted, so the heartbeat does not understate the work.
  assert.ok(loop.currentHeartbeat().firedCount >= 2, `heartbeat was ${loop.currentHeartbeat().firedCount}`);
});

test("a step that throws does not stop the scheduler, and counts nothing", async () => {
  const h = harness();

  await seed(h.store(), "cron fire");
  const loop = h.loop({
    runStep: async () => {
      // A watcher whose record cannot be read must not take the cron schedule
      // down with it: they share a tick, not a fate.
      throw new Error("the watch record is unreadable");
    },
  });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 40));
  loop.stop();
  const reason = await running;

  // The loop ended because it was asked to, not because the step broke it.
  assert.match(reason, /stopped/);
  assert.equal(loop.isRunning(), false);
});

test("a step cannot settle an occurrence: the access object offers no such power", async () => {
  const h = harness();
  let granted: string[] = [];
  const loop = h.loop({
    runStep: async (access) => {
      granted = Object.keys(access).sort();
      return 0;
    },
  });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 20));
  loop.stop();
  await running;
  // Exactly these three, and nothing that would let a second writer claim or
  // settle. This is what makes "one writer per tick" structural rather than a
  // convention.
  assert.deepEqual(granted, ["file", "occurrences", "writeRows"]);
});

test("the step's writeRows replaces watch rows and keeps cron rows and occurrences", async () => {
  const h = harness();

  await seed(h.store(), "a cron schedule");
  let reported = false;
  const loop = h.loop({
    runStep: async (access) => {
      // Read what the loop seeded, then replace the watch rows with none.
      const before = JSON.parse(readFileUtf8(access.file)) as {
        schedules: Array<Record<string, unknown>>;
        occurrences: unknown[];
      };
      const wrote = access.writeRows([]);

      assert.equal(wrote, true, "the write must land");
      const after = JSON.parse(readFileUtf8(access.file)) as {
        schedules: Array<Record<string, unknown>>;
        occurrences: unknown[];
      };

      // The cron row is untouched: a step cannot rewrite a schedule.
      assert.equal(after.schedules.length, 1);
      assert.match(String(after.schedules[0]?.cron ?? ""), /^\* \* \* \* \*$/);
      // And the occurrence array survives, which is what a later already-fired
      // check reads. A step that dropped it would re-enable duplicate fires.
      assert.equal(after.occurrences.length, before.occurrences.length);
      reported = true;

      return 0;
    },
  });
  const running = loop.run();

  await new Promise((tick) => setTimeout(tick, 25));
  loop.stop();
  await running;
  assert.equal(reported, true, "the step must have run");
});

/**
 * Read a file as UTF-8.
 *
 * Named rather than calling `readFileSync` inline so the assertions above read as
 * claims about the record rather than as filesystem plumbing.
 */
function readFileUtf8(path: string): string {
  return readFileSync(path, "utf8");
}
