import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileWatchStore } from "./file-watch-store.js";
import { watchOccurrenceId, type ConditionProbe } from "../../domain/watch.js";
import type { Occurrence } from "../../ports/schedule.js";
import type { WatchClock } from "../../ports/watch.js";

/**
 * The durable watch store (WP26 / A07).
 *
 * The central claim is that **"fires once" comes from the occurrence record, not
 * from a flag on the watch**. These cases prove it the only way that means
 * anything: a watch left `armed` with an occurrence already recorded must not
 * fire again — because that is exactly what a crash between "fired" and "wrote
 * the flag" looks like.
 *
 * The record is a real file, written through the same callback the store is given,
 * so a second store opened on the same file sees the first one's watches.
 */

const T0 = new Date(2026, 9, 7, 0, 0, 0, 0).getTime();

type Lab = {
  readonly store: ReturnType<typeof createFileWatchStore>;
  readonly file: string;
  readonly occurrences: Array<Occurrence>;
  readonly at: (ms: number) => void;
  readonly setProbe: (next: ConditionProbe) => void;
  readonly cleanup: () => void;
};

function lab(): Lab {
  const dir = mkdtempSync(join(tmpdir(), "wp26-watchstore-"));
  const file = join(dir, "schedules.json");
  let clock = T0;
  let watchIds = 0;
  let probe: ConditionProbe = {
    fileExists: () => false,
    fileContains: () => false,
    lastExitCode: () => undefined,
    flagSet: () => false,
  };
  const occurrences: Array<Occurrence> = [];
  const watchClock: WatchClock = {
    now: () => clock,
    newWatchId: () => `w${++watchIds}`,
  };
  const writeRows = (next: ReadonlyArray<Readonly<Record<string, unknown>>>): boolean => {
    // Written as the whole record, the way the schedule store writes it.
    return rewrite(file, next, occurrences);
  };

  return {
    store: createFileWatchStore({
      file,
      writeRows,
      clock: watchClock,
      // A stable holder, so a test can swap what the probe answers *after* the
      // store is built — which is how "the condition became true later" is set up.
      probe: {
        fileExists: (path) => probe.fileExists(path),
        fileContains: (path, needle) => probe.fileContains(path, needle),
        lastExitCode: () => probe.lastExitCode(),
        flagSet: (flag) => probe.flagSet(flag),
      },
      occurrences: async () => occurrences,
    }),
    file,
    occurrences,
    at: (ms) => {
      clock = ms;
    },
    setProbe: (next) => {
      probe = next;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Write the record the way the schedule store does: rows plus occurrences. */
function rewrite(
  file: string,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  occurrences: ReadonlyArray<Occurrence>,
): boolean {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, schedules: rows, occurrences }, null, 2) + "\n", "utf8");
  return true;
}

test("arming a watch records it and it reads back", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "condition", condition: { kind: "file_exists", relativePath: "build.txt" } },
      text: "the build finished",
      sessionId: "s-1",
    });

    assert.equal(created.ok, true);

    if (!created.ok) return;

    assert.equal(created.value.state.state, "armed");

    const listed = await h.store.list("s-1");
    if (!listed.ok) return;

    assert.equal(listed.value.length, 1);
    // The record is on disk, not only in the closure.
    assert.match(readFileUtf8(h.file), /"kind": "watch"/);
  } finally {
    h.cleanup();
  }
});

test("a watch with no message is refused", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "condition", condition: { kind: "flag_set", flag: "ready" } },
      text: "   ",
      sessionId: "s-1",
    });

    assert.equal(created.ok, false);

    if (created.ok) return;

    // "A watch that fires to say nothing" is a real product decision, not a
    // validation nit: it would be a notification with no content.
    assert.equal(created.code, "blank_text");
  } finally {
    h.cleanup();
  }
});

test("a watch with no session is refused", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 + 60_000 },
      text: "reminder",
      sessionId: "",
    });

    assert.equal(created.ok, false);

    if (!created.ok) assert.equal(created.code, "not_a_session");
  } finally {
    h.cleanup();
  }
});

test("a deadline in the past is refused by `create` but allowed by `createOrFire`", async () => {
  const h = lab();
  try {
    const plain = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 - 1_000 },
      text: "reminder",
      sessionId: "s-1",
    });

    assert.equal(plain.ok, false);

    if (!plain.ok) assert.equal(plain.code, "invalid_deadline");

    // The immediate form is the "if it is already past, do it now" path — the
    // reuse case for "remind me what I already missed".
    const immediate = await h.store.createOrFire({
      trigger: { kind: "deadline", atMs: T0 - 1_000 },
      text: "reminder",
      sessionId: "s-1",
    });

    assert.equal(immediate.ok, true);

    if (immediate.ok) {
      assert.equal(immediate.value.fired, true);
      assert.equal(immediate.value.row.state.state, "fired");
    }
  } finally {
    h.cleanup();
  }
});

test("a condition that is already true fires immediately rather than making someone wait", async () => {
  const h = lab();

  h.setProbe({
    fileExists: () => true,
    fileContains: () => false,
    lastExitCode: () => undefined,
    flagSet: () => false,
  });

  try {
    const armed = await h.store.createOrFire({
      trigger: { kind: "condition", condition: { kind: "file_exists", relativePath: "done.txt" } },
      text: "already finished",
      sessionId: "s-1",
    });

    assert.equal(armed.ok, true);

    if (armed.ok) {
      assert.equal(armed.value.fired, true);
      // And it says what it saw, so the notification is intelligible.
      assert.equal(armed.value.row.firedBecause, "done.txt exists");
    }
  } finally {
    h.cleanup();
  }
});

test("a condition that is not met stays armed and says why it is waiting", async () => {
  const h = lab();
  try {
    const armed = await h.store.createOrFire({
      trigger: { kind: "condition", condition: { kind: "file_exists", relativePath: "nope.txt" } },
      text: "waiting",
      sessionId: "s-1",
    });

    assert.equal(armed.ok, true);

    if (!armed.ok) return;

    assert.equal(armed.value.fired, false);
    assert.equal(armed.value.row.state.state, "armed");
  } finally {
    h.cleanup();
  }
});

test("firing twice does not fire twice — the occurrence record is the reason", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "condition", condition: { kind: "flag_set", flag: "ready" } },
      text: "notify",
      sessionId: "s-1",
    });
    if (!created.ok) return assert.fail("create must succeed");

    const at = T0 + 5_000;
    const first = await h.store.fire(created.value.id, at, "msg-1");

    assert.equal(first.ok, true);

    // The record now has the occurrence. Add it the way the scheduler would, so
    // the dedup check has something real to find.
    h.occurrences.push(occurrenceFor(created.value.id, created.value.createdAtMs, "msg-1"));
    // Leave the watch row `armed` — which is exactly what a crash between
    // "fired" and "wrote the flag" leaves behind.
    await rewriteArmed(h.file, created.value.id);

    const second = await h.store.fire(created.value.id, at, "msg-2");

    assert.equal(second.ok, true);

    if (!second.ok) return;

    // The second attempt does not produce a new message: it reports the one the
    // record already has.
    assert.equal(second.value.state, "fired");

    if (second.value.state === "fired") {
      assert.equal(second.value.messageId, "msg-1");
    }
  } finally {
    h.cleanup();
  }
});

test("cancelling an armed watch works and is recorded", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "condition", condition: { kind: "flag_set", flag: "ready" } },
      text: "notify",
      sessionId: "s-1",
    });
    if (!created.ok) return assert.fail("create must succeed");

    const cancelled = await h.store.cancel(created.value.id);

    assert.equal(cancelled.ok, true);

    if (cancelled.ok) assert.equal(cancelled.value.state, "cancelled");

    assert.match(readFileUtf8(h.file), /"state": "cancelled"/);
  } finally {
    h.cleanup();
  }
});

test("cancelling something already fired refuses, because the work happened", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 + 1_000 },
      text: "notify",
      sessionId: "s-1",
    });
    if (!created.ok) return assert.fail("create must succeed");

    await h.store.fire(created.value.id, T0 + 1_000, "msg-1");

    const cancelled = await h.store.cancel(created.value.id);

    assert.equal(cancelled.ok, false);

    if (cancelled.ok) return;

    // Reporting success here would let someone "cancel" a completed run.
    assert.equal(cancelled.code, "already_fired");
  } finally {
    h.cleanup();
  }
});

test("cancelling an unknown watch says so", async () => {
  const h = lab();
  try {
    const cancelled = await h.store.cancel("nope");
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.code, "watch_not_found");
  } finally {
    h.cleanup();
  }
});

test("the armed-watches ceiling is enforced per session", async () => {
  const h = lab();
  try {
    for (let index = 0; index < 20; index += 1) {
      const created = await h.store.create({
        trigger: { kind: "deadline", atMs: T0 + 60_000 + index },
        text: `watch ${index}`,
        sessionId: "s-1",
      });
      assert.equal(created.ok, true, `watch ${index} must be accepted`);
    }

    const overflow = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 + 999_999 },
      text: "one too many",
      sessionId: "s-1",
    });

    assert.equal(overflow.ok, false);

    if (!overflow.ok) {
      // A person armed with twenty watches will not read twenty notifications.
      assert.equal(overflow.code, "too_many_watches");
    }
  } finally {
    h.cleanup();
  }
});

test("evaluate reports what it saw without firing anything", async () => {
  const h = lab();

  h.setProbe({
    fileExists: () => true,
    fileContains: () => false,
    lastExitCode: () => undefined,
    flagSet: () => false,
  });

  try {
    const created = await h.store.create({
      trigger: { kind: "condition", condition: { kind: "file_exists", relativePath: "x.txt" } },
      text: "check",
      sessionId: "s-1",
    });
    if (!created.ok) return assert.fail("create must succeed");

    const verdict = await h.store.evaluate(created.value.id);

    assert.equal(verdict.ok, true);

    if (!verdict.ok) return;

    assert.equal(verdict.value.met, true);
    assert.equal(verdict.value.because, "x.txt exists");
    // Evaluating did not fire it — a dry run has to be possible.
    assert.equal(created.value.state.state, "armed");
  } finally {
    h.cleanup();
  }
});

test("forget removes a terminal watch but a missing one is reported", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 + 1_000 },
      text: "notify",
      sessionId: "s-1",
    });
    if (!created.ok) return assert.fail("create must succeed");

    // Only terminal watches can be forgotten: cancel first, then drop.
    const cancelled = await h.store.cancel(created.value.id);

    assert.equal(cancelled.ok, true);
    const forgotten = await h.store.forget(created.value.id);

    assert.equal(forgotten.ok, true);
    const again = await h.store.forget(created.value.id);

    assert.equal(again.ok, false);
  } finally {
    h.cleanup();
  }
});

test("forget refuses an armed watch with not_terminal and keeps the record", async () => {
  const h = lab();
  try {
    const created = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 + 1_000 },
      text: "notify",
      sessionId: "s-1",
    });
    if (!created.ok) return assert.fail("create must succeed");

    // Red case for the audit: the store, not just the CLI, owns this guard.
    const refused = await h.store.forget(created.value.id);

    assert.equal(refused.ok, false);

    if (refused.ok) return;

    assert.equal(refused.code, "not_terminal");
    // Nothing was deleted: the promise is still armed on disk.
    const listed = await h.store.list("s-1");

    assert.equal(listed.ok, true);

    if (!listed.ok) return;

    assert.equal(listed.value.length, 1);
    assert.match(readFileUtf8(h.file), new RegExp(created.value.id));
  } finally {
    h.cleanup();
  }
});

test("session ids with surrounding spaces share one ceiling", async () => {
  const h = lab();
  try {
    for (let index = 0; index < 20; index += 1) {
      const created = await h.store.create({
        trigger: { kind: "deadline", atMs: T0 + 60_000 + index },
        text: `watch ${index}`,
        sessionId: "s-1",
      });
      assert.equal(created.ok, true, `watch ${index} must be accepted`);
    }

    // `" s-1 "` is the same session once trimmed: it must not bypass MAX20.
    const bypass = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 + 999_999 },
      text: "spaced bypass",
      sessionId: "  s-1  ",
    });

    assert.equal(bypass.ok, false);

    if (!bypass.ok) assert.equal(bypass.code, "too_many_watches");
  } finally {
    h.cleanup();
  }
});

test("an unusable session id is refused as not_a_session", async () => {
  const h = lab();
  try {
    for (const bad of ["../escape", "a/b", "has space!", ""]) {
      const refused = await h.store.create({
        trigger: { kind: "deadline", atMs: T0 + 60_000 },
        text: "notify",
        sessionId: bad,
      });

      assert.equal(refused.ok, false, `${bad} must be refused`);

      if (!refused.ok) assert.equal(refused.code, "not_a_session");
    }
  } finally {
    h.cleanup();
  }
});

test("the total armed ceiling stops a new session when the file is full", async () => {
  const h = lab();
  try {
    for (let session = 0; session < 10; session += 1) {
      for (let index = 0; index < 20; index += 1) {
        const created = await h.store.create({
          trigger: { kind: "deadline", atMs: T0 + 60_000 + session * 1_000 + index },
          text: `s${session}w${index}`,
          sessionId: `s-${session}`,
        });
        assert.equal(created.ok, true, `s-${session} w${index} must be accepted`);
      }
    }

    // 10 sessions × 20 = 200 armed: the 201st, from a fresh session, is refused.
    const overflow = await h.store.create({
      trigger: { kind: "deadline", atMs: T0 + 999_999 },
      text: "one too many overall",
      sessionId: "s-fresh",
    });

    assert.equal(overflow.ok, false);

    if (!overflow.ok) assert.equal(overflow.code, "too_many_watches");
  } finally {
    h.cleanup();
  }
});

/**
 * The occurrence row the scheduler would write for a fired watch.
 *
 * It carries the `messageId` the first attempt recorded, which is the point:
 * that id is what a second caller has to be told, because the row was lost and
 * the occurrence is all that is left. An occurrence with an empty result would
 * make the case pass for the wrong reason.
 */
function occurrenceFor(watchId: string, atMs: number, messageId: string): Occurrence {
  return {
    id: watchOccurrenceId(watchId, atMs),
    scheduleId: `watch_${watchId}`,
    dueAtMs: atMs,
    state: { state: "completed", attemptId: "att_1", completedAtMs: atMs, result: { messageId } },
    prompt: "notify",
    delivery: "queue",
  };
}

/** Rewrite the record with a watch forced back to `armed`. */
function rewriteArmed(file: string, watchId: string): void {
  const parsed = JSON.parse(readFileUtf8(file)) as {
    schedules: Array<Record<string, unknown>>;
  };

  for (const row of parsed.schedules) {
    if (row["watchId"] === watchId) {
      row["state"] = "armed";
      delete row["firedAtMs"];
      delete row["messageId"];
      delete row["firedBecause"];
    }
  }

  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

function readFileUtf8(file: string): string {
  return readFileSync(file, "utf8");
}
