import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  alreadyFired,
  cancelWatch,
  describeCondition,
  describeWatch,
  evaluateCondition,
  fireRequestFor,
  watchOccurrenceId,
  type ConditionProbe,
  type WatchCondition,
  type WatchState,
} from "./watch.js";
import type { Occurrence } from "../ports/schedule.js";

/**
 * Watching for a condition and firing once (WP26 / A07, the retained part).
 *
 * The cases here are the ones where a condition watcher misbehaves in a way that
 * is invisible until it has already cost something:
 *
 *  - a condition that stays true firing on every tick (the burst);
 *  - a restart re-deriving a watch and firing the same one twice;
 *  - a cancel that reports success on something that already ran.
 *
 * The file conditions use **real files**, because "does this file exist" is the
 * one place where a mock would hide a path bug that only shows up in production.
 */

const T0 = new Date(2026, 9, 7, 0, 0, 0, 0).getTime();

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "wp26-watch-"));
}

function probeFor(overrides: Partial<ConditionProbe> = {}): ConditionProbe {
  return {
    fileExists: () => false,
    fileContains: () => false,
    lastExitCode: () => undefined,
    flagSet: () => false,
    ...overrides,
  };
}

function settled(...ids: string[]): ReadonlyArray<Occurrence> {
  return ids.map((id) => ({
    id,
    scheduleId: "watch_w1",
    dueAtMs: T0,
    state: { state: "completed" as const, attemptId: "att_1", completedAtMs: T0, result: {} },
    prompt: "p",
    delivery: "queue" as const,
  }));
}

test("a file that does not exist yet does not satisfy the watch", () => {
  const root = workspace();
  try {
    const verdict = evaluateCondition(
      { kind: "file_exists", relativePath: join(root, "build.txt") },
      probeFor({ fileExists: (p) => p === join(root, "build.txt") && false }),
    );
    assert.equal(verdict.met, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real file appearing satisfies the watch, and says which file", () => {
  const root = workspace();
  try {
    const target = join(root, "build.txt");
    const condition: WatchCondition = { kind: "file_exists", relativePath: target };
    // Before: not met. After the file is really written: met.
    const before = evaluateCondition(condition, probeFor({
      fileExists: (p) => {
        try {
          readFileSync(p, "utf8");
          return true;
        } catch {
          return false;
        }
      },
    }));

    assert.equal(before.met, false);

    writeFileSync(target, "done", "utf8");
    const after = evaluateCondition(condition, probeFor({
      fileExists: (p) => {
        try {
          readFileSync(p, "utf8");
          return true;
        } catch {
          return false;
        }
      },
    }));

    assert.equal(after.met, true);

    if (after.met) assert.match(after.because, /build\.txt exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contents and exit codes are separate conditions, and both name what they saw", () => {
  const contains = evaluateCondition(
    { kind: "file_contains", relativePath: "/tmp/out", needle: "DONE" },
    probeFor({ fileContains: () => true }),
  );

  assert.equal(contains.met, true);

  if (contains.met) assert.match(contains.because, /contains "DONE"/);

  const exit = evaluateCondition(
    { kind: "command_exit", exitCode: 0 },
    probeFor({ lastExitCode: () => 0 }),
  );

  assert.equal(exit.met, true);
  // A build that failed is not a build that succeeded, even though both are "an
  // exit code" — so the code is part of the condition.
  const failed = evaluateCondition(
    { kind: "command_exit", exitCode: 0 },
    probeFor({ lastExitCode: () => 1 }),
  );

  assert.equal(failed.met, false);
});

test("a flag is a condition, which is how a session says the thing is true", () => {
  const verdict = evaluateCondition(
    { kind: "flag_set", flag: "deploy-ready" },
    probeFor({ flagSet: (flag) => flag === "deploy-ready" }),
  );
  assert.equal(verdict.met, true);
});

test("the occurrence id is derived, so a restart re-derives the same one", () => {
  // This is the whole deduplication mechanism: two derivations of the same watch
  // at the same moment produce the same id, and the record can therefore say
  // "this already fired".
  const first = watchOccurrenceId("w1", T0);
  const second = watchOccurrenceId("w1", T0);

  assert.equal(first, second);
  assert.match(first, /^watch_w1@/);
  // And a different moment is a different occurrence, which is what lets a watch
  // fire again tomorrow.
  assert.notEqual(watchOccurrenceId("w1", T0), watchOccurrenceId("w1", T0 + 1));
});

test("a condition that stays true does not fire twice", () => {
  const id = watchOccurrenceId("w1", T0);
  // First tick: nothing settled, so it may fire.
  assert.equal(alreadyFired([], "w1", T0), false);
  // After it fired, every later tick sees the settled occurrence and stops.
  assert.equal(alreadyFired(settled(id), "w1", T0), true);
});

test("a different watch at the same moment is a different occurrence", () => {
  // The property that makes deduplication safe rather than a blunt "only one ever".
  const w1 = watchOccurrenceId("w1", T0);
  assert.equal(alreadyFired(settled(w1), "w2", T0), false);
});

test("an armed watch can be cancelled, and says why", () => {
  const armed: WatchState = { state: "armed", watchId: "w1", fireAtMs: T0 };
  const verdict = cancelWatch(armed, "w1", T0 + 5_000);

  assert.equal(verdict.kind, "cancelled");

  if (verdict.kind === "cancelled") {
    assert.equal(verdict.state.state, "cancelled");
    if (verdict.state.state === "cancelled") {
      // "Before it fired" is the fact, and it is the one that tells the caller
      // whether work was already done.
      assert.match(verdict.state.reason, /before it fired/);
    }
  }
});

test("cancelling something already fired refuses, because the work happened", () => {
  const fired: WatchState = { state: "fired", watchId: "w1", firedAtMs: T0, messageId: "m1" };
  const verdict = cancelWatch(fired, "w1", T0 + 1);
  // Reporting success here would let someone "cancel" a completed run and
  // believe they had.
  assert.equal(verdict.kind, "already_fired");
});

test("cancelling an unknown watch says so", () => {
  const verdict = cancelWatch(undefined, "nope", T0);
  assert.equal(verdict.kind, "not_found");
  if (verdict.kind === "not_found") assert.match(verdict.message, /fired already/);
});

test("cancelling twice is answered, not re-done", () => {
  const once = cancelWatch({ state: "armed", watchId: "w1", fireAtMs: T0 }, "w1", T0);
  assert.equal(once.kind, "cancelled");
  if (once.kind !== "cancelled") return;
  const twice = cancelWatch(once.state, "w1", T0 + 1);
  assert.equal(twice.kind, "already_cancelled");
});

test("an armed watch says what it is waiting for", () => {
  const armed: WatchState = { state: "armed", watchId: "w1", fireAtMs: T0 };
  const described = describeWatch(armed, { kind: "file_exists", relativePath: "build.txt" });
  // A list of five "armed" rows answers nothing; the condition is the answer.
  assert.match(described, /build\.txt to exist/);
  assert.match(described, /armed/);
});

test("a fired watch reports when it fired and which message it left", () => {
  const fired: WatchState = { state: "fired", watchId: "w1", firedAtMs: T0, messageId: "msg-7" };
  const described = describeWatch(fired, { kind: "flag_set", flag: "ready" });
  assert.match(described, /fired/);
  assert.match(described, /msg-7/);
});

test("the fire request carries the occurrence id the record will use", () => {
  const request = fireRequestFor("w1", T0, "s-1", "the build finished");
  // The id and the text travel together, so a caller cannot enqueue a message
  // that no later check will recognise as this watch.
  assert.equal(request.occurrenceId, watchOccurrenceId("w1", T0));
  assert.equal(request.sessionId, "s-1");
  assert.equal(request.text, "the build finished");
});

test("every condition describes itself in words", () => {
  for (const condition of [
    { kind: "file_exists", relativePath: "a.txt" },
    { kind: "file_contains", relativePath: "a.txt", needle: "DONE" },
    { kind: "command_exit", exitCode: 0 },
    { kind: "flag_set", flag: "ready" },
  ] as ReadonlyArray<WatchCondition>) {
    assert.ok(describeCondition(condition).length > 0, `${condition.kind} must describe itself`);
  }
});
