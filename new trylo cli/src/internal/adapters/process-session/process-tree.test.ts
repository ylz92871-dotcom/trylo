import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChildProcess } from "node:child_process";

import { terminateProcessTree, type TreeKillDeps } from "./process-tree.js";

/**
 * The decision layer of tree termination, tested without killing anything real.
 *
 * What is being pinned is the part that is easy to get quietly wrong: a walk
 * that fails must be *reported*, a platform with no walk must not pretend to
 * have one, and stopping something already stopped must stay a success. The
 * real-machine behaviour lives in `process-tree.platform.test.ts` — these cases
 * exist so a failure there is unambiguous rather than a mystery.
 */

type FakeChild = ChildProcess & { exitCode: number | null; signalCode?: NodeJS.Signals | null };

function fakeChild(overrides: { pid?: number | undefined; exitCode?: number | null } = {}): FakeChild {
  return {
    pid: overrides.pid ?? 4242,
    exitCode: overrides.exitCode ?? null,
    signalCode: null,
    kill: () => true,
  } as unknown as FakeChild;
}

function recordingDeps(
  platform: NodeJS.Platform,
  code: number | undefined,
): { deps: TreeKillDeps; calls: Array<{ file: string; args: ReadonlyArray<string> }> } {
  const calls: Array<{ file: string; args: ReadonlyArray<string> }> = [];
  return {
    calls,
    deps: {
      platform,
      run: async (file, args) => {
        calls.push({ file, args });
        return code;
      },
    },
  };
}

test("an already-exited child is already_gone and never launches a helper", async () => {
  const { deps, calls } = recordingDeps("win32", 0);
  const outcome = await terminateProcessTree(fakeChild({ exitCode: 0 }), deps);
  assert.deepEqual(outcome, { ok: true, how: "already_gone" });
  assert.equal(calls.length, 0, "a finished process needs no kill");
});

test("windows asks taskkill for the tree and the force flag, naming the pid", async () => {
  const { deps, calls } = recordingDeps("win32", 0);
  const outcome = await terminateProcessTree(fakeChild({ pid: 777 }), deps);
  assert.deepEqual(outcome, { ok: true, how: "killed" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "taskkill");
  assert.deepEqual(calls[0]?.args, ["/PID", "777", "/T", "/F"]);
});

test("the direct child is NOT killed before the walk — taskkill walks from it", async () => {
  // Regression pin with teeth. `taskkill /T` walks downward from the parent, so
  // a parent killed first leaves nothing to walk from: the helper exits 128 and
  // the descendants survive. Measured in
  // `evidence/2026-10-05-WP07/05-taskkill-ordering.log`, where this ordering
  // left a grandchild running and acting while the stop reported success.
  let directKills = 0;
  const child = fakeChild({ pid: 777 });

  (child as { kill: () => boolean }).kill = () => {
    directKills += 1;
    return true;
  };
  const { deps } = recordingDeps("win32", 0);
  const outcome = await terminateProcessTree(child, deps);

  assert.equal(outcome.ok, true);
  assert.equal(directKills, 0, "the parent must stay alive for the tree walk to start from");
});

test("a helper that cannot be launched still kills the direct child, and says so", async () => {
  let directKills = 0;
  const child = fakeChild({ pid: 777 });

  (child as { kill: () => boolean }).kill = () => {
    directKills += 1;
    return true;
  };
  const { deps } = recordingDeps("win32", undefined);
  const outcome = await terminateProcessTree(child, deps);

  assert.equal(directKills, 1, "the fallback exists for exactly this case");
  assert.equal(outcome.ok, false);

  if (outcome.ok) throw new Error("expected failure");

  assert.equal(outcome.code, "tree_kill_helper_missing");
});

test("taskkill reporting 'nothing to kill' is success, not a failure", async () => {
  // Windows exits 128 when the target is already gone. That is the outcome the
  // caller wanted, so it must not read as a failed stop.
  const { deps } = recordingDeps("win32", 128);
  const outcome = await terminateProcessTree(fakeChild(), deps);
  assert.equal(outcome.ok, true);
});

test("a helper that cannot be launched is reported, not swallowed", async () => {
  const { deps } = recordingDeps("win32", undefined);
  const outcome = await terminateProcessTree(fakeChild(), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.code, "tree_kill_helper_missing");
  assert.match(outcome.message, /descendants may survive/);
});

test("a helper that refuses is reported with its exit code", async () => {
  const { deps } = recordingDeps("win32", 5);
  const outcome = await terminateProcessTree(fakeChild(), deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.code, "tree_kill_rejected");
  assert.match(outcome.message, /exited 5/);
});

test("a platform with no walk says so instead of claiming the tree died", async () => {
  const { deps, calls } = recordingDeps("aix", 0);
  const outcome = await terminateProcessTree(fakeChild(), deps);

  assert.equal(outcome.ok, false);

  if (outcome.ok) throw new Error("expected failure");

  assert.equal(outcome.code, "tree_kill_unsupported_platform");
  assert.match(outcome.message, /aix/);
  assert.equal(calls.length, 0, "no helper may be launched on a platform with no walk");
});

test("stopping twice is idempotent: the second call is already_gone", async () => {
  // A user pressing stop twice, or a timeout firing beside a cancel, must not
  // turn a completed stop into an error.
  let first = true;
  const deps: TreeKillDeps = {
    platform: "win32",
    run: async () => {
      if (first) {
        first = false;
        return 0;
      }
      return 128;
    },
  };
  const child = fakeChild();

  assert.deepEqual(await terminateProcessTree(child, deps), { ok: true, how: "killed" });
  child.exitCode = 1; // the walk ended it
  assert.deepEqual(await terminateProcessTree(child, deps), { ok: true, how: "already_gone" });
});

/**
 * F9: the Unix branch had no test at all, because `process.kill` was called
 * directly and the whole "graceful, check, escalate" ladder ran inside one tick
 * with no `await` — the checks were dead code, the grace window was zero, and
 * `{ok: true}` was returned without anything being observed. Evidence:
 * `evidence/2026-10-05-WP07/11-posix-grace-window-probe.log`.
 *
 * These cases drive the seam instead, so the timing and the observation are
 * both facts the test controls rather than facts about this machine.
 */
type UnixDeps = {
  deps: TreeKillDeps;
  signals: NodeJS.Signals[];
  waits: number[];
};

function unixDeps(alive: (pid: number) => boolean, graceMs = 2_000, settleMs = 1_000): UnixDeps {
  const signals: NodeJS.Signals[] = [];
  const waits: number[] = [];

  return {
    signals,
    waits,
    deps: {
      platform: "linux",
      run: async () => 0,
      signalGroup: (_pid, signal) => {
        signals.push(signal);
      },
      groupGone: alive,
      graceMs: () => graceMs,
      settleMs: () => settleMs,
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  };
}

test("a group that dies on the graceful signal never needs the force", async () => {
  let gone = false;
  const { deps, signals, waits } = unixDeps(() => {
    if (!gone) {
      gone = true;
    }
    return gone;
  });
  const outcome = await terminateProcessTree(fakeChild({ pid: 555 }), deps);

  assert.deepEqual(outcome, { ok: true, how: "killed" });
  assert.deepEqual(signals, ["SIGTERM"], "SIGKILL must not be sent to a group that complied");
  assert.deepEqual(waits, [], "a group that dies immediately needs no grace window spent");
});

test("the graceful signal is actually given time before the force", async () => {
  const { deps, signals, waits } = unixDeps(() => signals.includes("SIGKILL"), 2_000, 1_000);
  const outcome = await terminateProcessTree(fakeChild({ pid: 555 }), deps);

  assert.equal(outcome.ok, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "escalate only after the window");
  assert.equal(waits.reduce((total, value) => total + value, 0), 2_000);
});

test("a group that exits during grace returns after the first poll", async () => {
  const { deps, signals, waits } = unixDeps(() => waits.length > 0);
  const outcome = await terminateProcessTree(fakeChild({ pid: 555 }), deps);

  assert.deepEqual(outcome, { ok: true, how: "killed" });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(waits, [50]);
});

test("Darwin observes exit after a transient permission error and never forces a denied group", async () => {
  const denied = () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); };
  const transient = unixDeps(() => transient.waits.length === 0 ? denied() : true);
  const recovered = await terminateProcessTree(fakeChild({ pid: 555 }), { ...transient.deps, platform: "darwin" });
  assert.deepEqual(recovered, { ok: true, how: "killed" });
  assert.deepEqual(transient.signals, ["SIGTERM"]);

  const persistent = unixDeps(denied);
  const refused = await terminateProcessTree(fakeChild({ pid: 555 }), { ...persistent.deps, platform: "darwin" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "tree_kill_unobservable");
  assert.deepEqual(persistent.signals, ["SIGTERM"]);
});

test("a tree that outlives SIGKILL is reported, never declared killed", async () => {
  const { deps, signals } = unixDeps(() => false);
  const outcome = await terminateProcessTree(fakeChild({ pid: 555 }), deps);

  assert.equal(outcome.ok, false, "an unobservable kill must not read as success");

  if (outcome.ok) throw new Error("expected failure");

  assert.equal(outcome.code, "tree_kill_unconfirmed");
  assert.match(outcome.message, /descendants may survive/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "both were tried before giving up");
});

test("a platform with no observation seam reports unobservable instead of guessing", async () => {
  const deps: TreeKillDeps = { platform: "darwin", run: async () => 0 };
  const outcome = await terminateProcessTree(fakeChild({ pid: 555 }), deps);
  assert.equal(outcome.ok, false, "no observation means no claim");
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.code, "tree_kill_unobservable");
});

test("a group that is already gone never gets a signal", async () => {
  const { deps, signals } = unixDeps(() => true);
  const outcome = await terminateProcessTree(fakeChild({ pid: 555, exitCode: 0 }), deps);
  assert.deepEqual(outcome, { ok: true, how: "already_gone" });
  assert.deepEqual(signals, []);
});
