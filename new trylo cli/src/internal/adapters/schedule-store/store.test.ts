import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { deleteConsequence, dueOccurrences, nextDueAtMs, settledState, validateSchedule } from "../../domain/schedule.js";
import { createFileScheduleStore } from "./store.js";

/**
 * The durable schedule store (WP26 / A06).
 *
 * Every case pins an **observable** fact — a file's bytes, a refusal code, an
 * occurrence's state — rather than a call being made. The distinction matters
 * here because the whole point of the store is what survives a crash, and "the
 * method was called" survives nothing.
 *
 * The clock and the id factory are injected, so "the schedule fired" is a fact
 * about an argument rather than a fact about how long the test waited.
 */

function home(): string {
  return mkdtempSync(join(tmpdir(), "wp26-sched-"));
}

/** A clock the test moves by hand, and attempt ids it can count. */
function testClock(startMs: number) {
  let current = startMs;
  let attempts = 0;

  return {
    now: () => current,
    newAttemptId: () => `att_${++attempts}`,
    advanceTo(ms: number) {
      current = ms;
    },
  };
}

const EVERY_MINUTE = "* * * * *";

/** Base instant: a Wednesday 00:00 local, so minute arithmetic is readable. */
const T0 = new Date(2026, 9, 7, 0, 0, 0, 0).getTime();

function newStore(overrides: { readonly clock?: ReturnType<typeof testClock>; readonly homeDir?: string } = {}) {
  const clock = overrides.clock ?? testClock(T0);
  const store = createFileScheduleStore({
    home: overrides.homeDir ?? home(),
    clock,
    ownerId: "owner-a",
    pid: 1000,
    recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });

  return { store, clock };
}

test("a created schedule is durable: it is readable after a new store opens the file", async () => {
  const homeDir = home();
  const { store } = newStore({ homeDir });
  const created = await store.create({ cron: "0 9 * * *", prompt: "check the build", recurring: true, durable: true, delivery: "queue" });

  assert.equal(created.ok, true);

  if (!created.ok) return;

  assert.match(created.value.id, /^sch_/);

  // A second store, same home: the schedule must be there, because it was
  // acknowledged before this process existed.
  const reopened = newStore({ homeDir }).store;
  const listed = await reopened.list();

  assert.equal(listed.ok, true);

  if (!listed.ok) return;

  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0]?.prompt, "check the build");
  assert.equal(listed.value[0]?.cron, "0 9 * * *");
});

test("an invalid expression is refused at creation, not accepted and never fired", async () => {
  const { store } = newStore();

  for (const cron of ["bogus", "* * * *", "60 * * * *", "*/0 * * * *"]) {
    const created = await store.create({ cron, prompt: "x", recurring: true, durable: false, delivery: "queue" });
    assert.equal(created.ok, false, `${cron} must be refused`);
    if (created.ok) continue;
    assert.equal(created.code, "invalid_expression");
  }

  const listed = await store.list();

  assert.equal(listed.ok, true);

  if (listed.ok) assert.equal(listed.value.length, 0);
});

test("a blank prompt is refused; an empty schedule is not a task", async () => {
  const validated = validateSchedule({ cron: EVERY_MINUTE, prompt: "   " });
  assert.equal(validated.ok, false);
  if (validated.ok) return;
  assert.equal(validated.code, "invalid_prompt");
});

test("claiming due work requires the lease, and an unwritten token is refused", async () => {
  const { store, clock } = newStore();

  await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });

  // No lease taken at all.
  const unleased = await store.claimDue(clock.now(), "made-up-token");

  assert.equal(unleased.ok, false);

  if (unleased.ok) return;

  assert.equal(unleased.code, "lease_lost");

  const took = await store.acquireLease("owner-a");

  assert.equal(took.ok, true);

  if (!took.ok) return;

  const claimed = await store.claimDue(clock.now(), took.value);

  assert.equal(claimed.ok, true);
});

test("a due occurrence is claimed once and never twice for the same instant", async () => {
  const { store, clock } = newStore();

  await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  clock.advanceTo(T0 + 61_000);
  const first = await store.claimDue(clock.now(), took.value);
  if (!first.ok) return assert.fail("claim must succeed");

  assert.equal(first.value.length, 1);
  const occurrence = first.value[0];

  assert.ok(occurrence !== undefined);
  // Deterministic identity: the same schedule and the same due moment always name
  // the same occurrence, which is what makes a restart recognisable rather than
  // duplicating. The id is `<scheduleId>@<dueAtMs>` — both halves named, because
  // "it has the right shape" would survive a change that broke the determinism.
  assert.equal(occurrence.id, `${occurrence.scheduleId}@${T0 + 60_000}`);
  assert.equal(occurrence.dueAtMs, T0 + 60_000);
  assert.equal(occurrence.prompt, "tick");

  // Same instant, second claim: nothing new, because the first is recorded.
  const second = await store.claimDue(clock.now(), took.value);
  if (!second.ok) return assert.fail("second claim must be answerable");

  assert.equal(second.value.length, 0);
});

test("nothing is due before the cron says so", async () => {
  const { store, clock } = newStore();

  await store.create({ cron: "0 9 * * *", prompt: "morning", recurring: true, durable: true, delivery: "queue" });
  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  const atMidnight = await store.claimDue(clock.now(), took.value);
  if (!atMidnight.ok) return assert.fail("claim must be answerable");

  assert.equal(atMidnight.value.length, 0);
});

test("settling advances the anchor, so a recurring schedule does not replay every missed slot", async () => {
  const { store, clock } = newStore();

  await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  clock.advanceTo(T0 + 61_000);
  const claimed = await store.claimDue(clock.now(), took.value);
  if (!claimed.ok) return assert.fail("claim must succeed");

  const occurrence = claimed.value[0];
  if (occurrence === undefined) return assert.fail("one occurrence expected");

  const settled = await store.settle(occurrence.id, { outcome: "completed", result: { ok: true } }, took.value);

  assert.equal(settled.ok, true);

  // A host that was down for an hour owes ONE occurrence, not sixty.
  clock.advanceTo(T0 + 61 * 60_000);
  const afterGap = await store.claimDue(clock.now(), took.value);
  if (!afterGap.ok) return assert.fail("claim must be answerable");

  assert.equal(afterGap.value.length, 1);
  // And it is the *next* minute after the settled one, not the first missed one.
  assert.equal(afterGap.value[0]?.dueAtMs, T0 + 2 * 60_000);
});

test("an unknown result is recorded as unknown, never as failed", async () => {
  const { store, clock } = newStore();

  await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  clock.advanceTo(T0 + 61_000);
  const claimed = await store.claimDue(clock.now(), took.value);
  const occurrence = claimed.ok ? claimed.value[0] : undefined;
  if (occurrence === undefined) return assert.fail("one occurrence expected");

  const settled = await store.settle(
    occurrence.id,
    { outcome: "unknown", reason: "the runner lost sight of the effect" },
    took.value,
  );
  if (!settled.ok) return assert.fail("settle must succeed");

  // `unknown` is its own state: it must not read as a failure, because a failure
  // invites a retry and a retry re-does an effect nobody observed.
  assert.equal(settled.value.state.state, "unknown");
});

test("settling twice does not rewrite a recorded outcome", async () => {
  const { store, clock } = newStore();

  await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  clock.advanceTo(T0 + 61_000);
  const claimed = await store.claimDue(clock.now(), took.value);
  const occurrence = claimed.ok ? claimed.value[0] : undefined;
  if (occurrence === undefined) return assert.fail("one occurrence expected");

  await store.settle(occurrence.id, { outcome: "failed", code: "boom", message: "it broke" }, took.value);
  const second = await store.settle(occurrence.id, { outcome: "completed", result: { ok: true } }, took.value);
  if (!second.ok) return assert.fail("second settle must be answerable");

  // A late duplicate from a retried caller must not replace a recorded failure
  // with a success nobody observed.
  assert.equal(second.value.state.state, "failed");
});

test("deleting tombstones the schedule and it stops producing work", async () => {
  const { store, clock } = newStore();
  const created = await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  if (!created.ok) return assert.fail("create must succeed");

  const deleted = await store.delete(created.value.id);

  assert.equal(deleted.ok, true);
  const listed = await store.list();
  if (listed.ok) assert.equal(listed.value.length, 0);

  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  clock.advanceTo(T0 + 61_000);
  const afterDelete = await store.claimDue(clock.now(), took.value);

  // The schedule is gone, so no work is owed. This is the ADR's "delete must
  // stop later execution", not merely "the row disappeared".
  if (afterDelete.ok) assert.equal(afterDelete.value.length, 0);
});

test("deleting an already-deleted schedule says so rather than claiming success", async () => {
  const { store } = newStore();
  const created = await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  if (!created.ok) return assert.fail("create must succeed");

  await store.delete(created.value.id);
  const again = await store.delete(created.value.id);

  assert.equal(again.ok, false);

  if (again.ok) return;

  assert.equal(again.code, "already_tombstoned");
});

test("delete reports what is already in flight instead of implying it stopped", () => {
  const schedule = {
    id: "sch_1",
    cron: EVERY_MINUTE,
    prompt: "p",
    createdAtMs: T0,
    recurring: true,
    durable: true,
    delivery: "queue" as const,
  };
  const dispatched = {
    id: "sch_1@" + (T0 + 60_000),
    scheduleId: "sch_1",
    dueAtMs: T0 + 60_000,
    state: { state: "dispatched" as const, attemptId: "att_1", dispatchedAtMs: T0 },
    prompt: "p",
    delivery: "queue" as const,
  };

  // The three cases have different remedies, so the answer is a union.
  assert.equal(deleteConsequence(schedule, []).kind, "not_yet_due");
  assert.equal(deleteConsequence(schedule, [dispatched]).kind, "in_flight");
  assert.equal(
    deleteConsequence(schedule, [
      { ...dispatched, state: { state: "unknown" as const, attemptId: "att_1", observedAtMs: T0, reason: "r" } },
    ]).kind,
    "unknown_in_flight",
  );
});

test("the delete consequence survives a round trip through the file", async () => {
  const homeDir = home();
  const { store, clock } = newStore({ homeDir });
  const created = await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  if (!created.ok) return assert.fail("create must succeed");

  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  clock.advanceTo(T0 + 61_000);
  const claimed = await store.claimDue(clock.now(), took.value);
  if (!claimed.ok || claimed.value[0] === undefined) return assert.fail("one occurrence expected");

  // Read the bytes and confirm the claim is really on disk, not just in memory.
  const file = join(homeDir, "schedule", "schedules.json");
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
    schedules: ReadonlyArray<{ id: string; lastFiredAtMs?: number }>;
    occurrences: ReadonlyArray<{ id: string; state: { state: string } }>;
  };

  assert.equal(onDisk.occurrences.length, 1);
  assert.equal(onDisk.occurrences[0]?.state.state, "claimed");
  // The anchor has NOT moved: a claim is not a fire.
  assert.equal(onDisk.schedules[0]?.lastFiredAtMs, undefined);
});

test("a corrupted record is reported unreadable, never as an empty schedule list", async () => {
  const homeDir = home();
  const { store } = newStore({ homeDir });
  const file = join(homeDir, "schedule", "schedules.json");

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{ this is not json", "utf8");
  const listed = await store.list();

  // "You have no schedules" and "I could not read yours" lead a person to
  // opposite conclusions, and only one of them is true.
  assert.equal(listed.ok, false);

  if (listed.ok) return;

  assert.equal(listed.code, "schedule_unreadable");
});

test("a row with the wrong shape is dropped rather than cast", async () => {
  const homeDir = home();
  const file = join(homeDir, "schedule", "schedules.json");

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      schedules: [
        { id: "sch_ok", cron: "0 9 * * *", prompt: "fine", createdAtMs: T0, delivery: "queue" },
        { id: "sch_no_cron", prompt: "broken", createdAtMs: T0, delivery: "queue" },
        { cron: "0 9 * * *", prompt: "no id", createdAtMs: T0, delivery: "queue" },
      ],
      occurrences: [],
    }),
    "utf8",
  );
  const { store } = newStore({ homeDir });
  const listed = await store.list();
  if (!listed.ok) return assert.fail("a row-level problem must not make the file unreadable");

  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0]?.id, "sch_ok");
});

test("occurrence identity is derived from the schedule and the instant", () => {
  const schedule = {
    id: "sch_7",
    cron: EVERY_MINUTE,
    prompt: "p",
    createdAtMs: T0,
    recurring: true,
    durable: true,
    delivery: "queue" as const,
  };
  const due = dueOccurrences([schedule], T0 + 61_000);

  assert.equal(due.length, 1);
  assert.equal(due[0]?.id, `sch_7@${T0 + 60_000}`);
  // Same inputs, same ids: that is the property recovery depends on.
  assert.deepEqual(dueOccurrences([schedule], T0 + 61_000), due);
  assert.equal(nextDueAtMs(schedule), T0 + 60_000);
});

test("a tombstoned schedule owes nothing", () => {
  const schedule = {
    id: "sch_8",
    cron: EVERY_MINUTE,
    prompt: "p",
    createdAtMs: T0,
    recurring: true,
    durable: true,
    delivery: "queue" as const,
    tombstonedAtMs: T0 + 1000,
  };

  assert.equal(dueOccurrences([schedule], T0 + 61_000).length, 0);
  assert.equal(nextDueAtMs(schedule), null);
});

test("a cancelled outcome before dispatch settles as cancelled with the reason, never a fabricated completion", () => {
  const atMs = T0 + 5_000;
  const fromDue = settledState(
    { state: "due" },
    { outcome: "cancelled", reason: "person withdrew the request" },
    atMs,
  );

  assert.equal(fromDue.state, "cancelled");

  if (fromDue.state !== "cancelled") return;

  // Nothing ran, so no attempt is invented and no result is fabricated: the
  // record carries the reason and the moment, and nothing else.
  assert.equal(fromDue.cancelledAtMs, atMs);
  assert.equal(fromDue.reason, "person withdrew the request");

  const fromClaimed = settledState(
    { state: "claimed", attemptId: "att_1", claimedAtMs: T0 },
    { outcome: "cancelled", reason: "no longer needed" },
    atMs,
  );

  assert.equal(fromClaimed.state, "cancelled");

  if (fromClaimed.state !== "cancelled") return;

  assert.equal(fromClaimed.reason, "no longer needed");
});

test("a cancelled outcome after dispatch settles as unknown, never completed, and never invites a retry", () => {
  const interrupted = settledState(
    { state: "dispatched", attemptId: "att_1", dispatchedAtMs: T0 },
    { outcome: "cancelled", reason: "stop arrived mid-run" },
    T0 + 5_000,
  );

  // The effect may have landed before the stop did, so this is an observation
  // gap rather than proof nothing ran. `unknown` hands it to reconciliation;
  // `completed` would be a lie about something nobody observed, and `failed`
  // would invite a retry of work that may already have happened.
  assert.equal(interrupted.state, "unknown");

  if (interrupted.state !== "unknown") return;

  assert.equal(interrupted.attemptId, "att_1");
  assert.match(interrupted.reason, /stop arrived mid-run/);
});

test("settling a cancelled or unknown occurrence twice does not rewrite it", async () => {
  const firsts = [
    { outcome: "cancelled", reason: "withdrawn" },
    { outcome: "unknown", reason: "lost sight of the effect" },
  ] as const;
  for (const first of firsts) {
    const { store, clock } = newStore();

    await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
    const took = await store.acquireLease("owner-a");
    if (!took.ok) return assert.fail("lease must be acquirable");

    clock.advanceTo(T0 + 61_000);
    const claimed = await store.claimDue(clock.now(), took.value);
    const occurrence = claimed.ok ? claimed.value[0] : undefined;
    if (occurrence === undefined) return assert.fail("one occurrence expected");

    const settled = await store.settle(occurrence.id, first, took.value);
    if (!settled.ok) return assert.fail("settle must succeed");

    const second = await store.settle(occurrence.id, { outcome: "completed", result: { ok: true } }, took.value);
    if (!second.ok) return assert.fail("second settle must be answerable");

    // A late duplicate — e.g. a runner that never heard the cancel — must not
    // replace the recorded terminal with a success nobody observed.
    assert.equal(second.value.state.state, first.outcome);
  }
});

test("delete writes only a tombstone: in-flight work stays named and is never recalled", async () => {
  const { store, clock } = newStore();
  const created = await store.create({ cron: EVERY_MINUTE, prompt: "tick", recurring: true, durable: true, delivery: "queue" });
  if (!created.ok) return assert.fail("create must succeed");

  const took = await store.acquireLease("owner-a");
  if (!took.ok) return assert.fail("lease must be acquirable");

  clock.advanceTo(T0 + 61_000);
  const claimed = await store.claimDue(clock.now(), took.value);
  if (!claimed.ok || claimed.value[0] === undefined) return assert.fail("one occurrence expected");

  const deleted = await store.delete(created.value.id);

  assert.equal(deleted.ok, true);
  // The tombstone stops new work, but the attempt already handed out is still
  // on record: deleting must not pretend it was recalled from the runner.
  const states = await store.occurrenceStatesOf(created.value.id);
  if (!states.ok) return assert.fail("states must be readable");

  assert.equal(states.value.length, 1);
  assert.equal(states.value[0]?.state, "claimed");
  const afterDelete = await store.claimDue(clock.now(), took.value);
  if (afterDelete.ok) assert.equal(afterDelete.value.length, 0);

  const listed = await store.listOccurrences();

  assert.equal(listed.filter((occurrence) => occurrence.scheduleId === created.value.id).length, 1);
});
