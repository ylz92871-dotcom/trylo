import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileDaemon } from "./file-daemon.js";
import { clearDiscovery, readDiscovery, writeDiscovery, writeHeartbeat } from "./record.js";
import type { DaemonIdentity } from "../../domain/daemon-identity.js";

/**
 * The daemon lifecycle answers (WP26 / A04).
 *
 * The spawn itself is proven by a real three-process probe
 * (`evidence/2026-10-07-WP26-review/daemon-start-e2e.out.txt`), because
 * "detached" means nothing in a single process. What is pinned here is the part
 * that *is* single-process: the state machine that decides what a discovery record
 * plus a live identity check mean together.
 *
 * The probe is injected in every case, so "the system will not tell us" and "the
 * process is gone" are states the test can state outright rather than arrange.
 */

const T0 = new Date(2026, 9, 7, 0, 0, 0, 0).getTime();

function harness(
  live: ReadonlyMap<number, DaemonIdentity> | "throws",
  over: Partial<Parameters<typeof createFileDaemon>[0]> = {},
) {
  const home = mkdtempSync(join(tmpdir(), "wp26-fd-"));
  const killed: Array<{ pid: number; force: boolean }> = [];
  const asked: Array<number> = [];
  let clock = T0;
  const daemon = createFileDaemon({
    home,
    clock: { now: () => clock },
    launch: { file: process.execPath, args: [] },
    platform: "win32",
    probe: {
      observe: async (pid) => {
        if (live === "throws") {
          throw new Error("the process table could not be read");
        }
        return live.get(pid);
      },
    },
    kill: async (pid, options) => {
      killed.push({ pid, force: options.force });
    },
    requestStop: async (pid) => {
      asked.push(pid);
    },
    tickIntervalMs: 1_000,
    // The fake launch never advertises, so the readiness wait is the thing under
    // test rather than a stopwatch: two looks, no real sleeping.
    ready: { attempts: 2, intervalMs: 0, sleep: async () => {} },
    ...over,
  });

  return {
    home,
    killed,
    asked,
    at: (ms: number) => {
      clock = ms;
    },
    daemon,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("no discovery record means stopped, not running and not a guess", async () => {
  const h = harness(new Map());
  const state = await h.daemon.status();
  // "A file exists" is not a status, and "no file" is not a failure to answer.
  assert.equal(state.status, "stopped");
  h.cleanup();
});

test("a record whose process is gone reads as stopped, not running", async () => {
  const h = harness(new Map());

  writeDiscovery(h.home, { pid: 777, startedAtMs: T0 - 5_000 });
  const state = await h.daemon.status();

  // The record outlived its process. Reporting `running` here is how a supervisor
  // convinces itself a daemon that died an hour ago is fine.
  assert.equal(state.status, "stopped");
  h.cleanup();
});

test("a live process with a matching identity reads as running, with its heartbeat", async () => {
  const identity = { pid: 777, startedAtMs: T0 - 5_000 };
  const h = harness(new Map([[777, identity]]));

  writeDiscovery(h.home, identity);
  writeHeartbeat(h.home, { lastTickAtMs: T0 - 200, firedCount: 4 });
  h.at(T0);
  const state = await h.daemon.status();

  assert.equal(state.status, "running");

  if (state.status !== "running") return;

  assert.equal(state.pid, 777);
  assert.equal(state.firedCount, 4);
  h.cleanup();
});

test("a reused pid is gone, not running", async () => {
  // Same pid, started a minute later: a different process wearing the same number.
  const h = harness(new Map([[777, { pid: 777, startedAtMs: T0 + 60_000 }]]));

  writeDiscovery(h.home, { pid: 777, startedAtMs: T0 - 5_000 });
  const state = await h.daemon.status();

  // This is the whole reason identity is a pair.
  assert.equal(state.status, "stopped");
  h.cleanup();
});

test("an unreadable process table is unhealthy, never running and never gone", async () => {
  const h = harness("throws");

  writeDiscovery(h.home, { pid: 777, startedAtMs: T0 - 5_000 });
  const state = await h.daemon.status();

  // Collapsing this to `gone` would start a replacement daemon on top of one that
  // is merely unanswerable; collapsing it to `running` would trust a record nobody
  // has checked.
  assert.equal(state.status, "unhealthy");

  if (state.status !== "unhealthy") return;

  assert.match(state.reason, /could not be read/);
  h.cleanup();
});

test("a heartbeat far behind the interval is unhealthy even though the process lives", async () => {
  const identity = { pid: 777, startedAtMs: T0 - 5_000 };
  const h = harness(new Map([[777, identity]]));

  writeDiscovery(h.home, identity);
  writeHeartbeat(h.home, { lastTickAtMs: T0 - 60_000, firedCount: 1 });
  h.at(T0);
  const state = await h.daemon.status();

  // Alive but not ticking is the state a pid-only check cannot see at all.
  assert.equal(state.status, "unhealthy");

  if (state.status !== "unhealthy") return;

  assert.match(state.reason, /heartbeat/);
  h.cleanup();
});

test("start is refused while a verified daemon is running", async () => {
  const identity = { pid: 777, startedAtMs: T0 - 5_000 };
  const h = harness(new Map([[777, identity]]));

  writeDiscovery(h.home, identity);
  writeHeartbeat(h.home, { lastTickAtMs: T0, firedCount: 0 });
  h.at(T0);
  const started = await h.daemon.start();

  assert.equal(started.ok, false);

  if (started.ok) return;

  // Starting a second daemon over a live one is how two schedulers race for the
  // lease, and the lease is the only thing preventing it.
  assert.equal(started.code, "already_running");
  assert.match(started.message, /pid 777/);
  h.cleanup();
});

test("start is refused when the identity cannot be confirmed, and says so", async () => {
  const h = harness("throws");

  writeDiscovery(h.home, { pid: 777, startedAtMs: T0 - 5_000 });
  const started = await h.daemon.start();

  assert.equal(started.ok, false);

  if (started.ok) return;

  assert.equal(started.code, "identity_unverifiable");
  h.cleanup();
});

test("a daemon that dies during launch is reported with what it managed to say", async () => {
  // The point of the log tail: this is the shape of the defect that hid for a whole
  // review round — a launch that produced a pid and nothing else. The failure has
  // to carry the child's own complaint, not a guess about it.
  const h = harness(new Map(), {
    launch: {
      file: process.execPath,
      args: ["-e", "console.error('MODULE_NOT_FOUND: daemon-main.js is missing')"],
    },
    ready: {
      attempts: 30,
      intervalMs: 20,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  });
  const started = await h.daemon.start();

  assert.equal(started.ok, false);

  if (started.ok) return;

  assert.equal(started.code, "spawn_failed");
  assert.match(started.message, /died during launch/);
  assert.match(started.message, /daemon-main\.js is missing/);
  h.cleanup();
});

test("stop refuses when nothing is running, rather than claiming a success", async () => {
  const h = harness(new Map());
  const stopped = await h.daemon.stop({});

  assert.equal(stopped.ok, false);

  if (stopped.ok) return;

  assert.equal(stopped.code, "not_running");
  assert.equal(h.killed.length, 0, "nothing may be killed when nothing is running");
  h.cleanup();
});

test("a graceful stop asks rather than kills", async () => {
  const identity = { pid: 777, startedAtMs: T0 - 5_000 };
  const h = harness(new Map([[777, identity]]));

  writeDiscovery(h.home, identity);
  writeHeartbeat(h.home, { lastTickAtMs: T0, firedCount: 0 });
  h.at(T0);
  const stopped = await h.daemon.stop({});

  assert.equal(stopped.ok, true);
  // The whole point of a grace period: the process gets the chance to settle.
  assert.deepEqual(h.asked, [777]);
  assert.deepEqual(h.killed, [], "a graceful stop must not kill");
  // And the record is withdrawn, so the next status does not find a phantom.
  assert.equal(readDiscovery(h.home), undefined);
  h.cleanup();
});

test("a forced stop kills and withdraws the record", async () => {
  const identity = { pid: 777, startedAtMs: T0 - 5_000 };
  const h = harness(new Map([[777, identity]]));

  writeDiscovery(h.home, identity);
  writeHeartbeat(h.home, { lastTickAtMs: T0, firedCount: 0 });
  h.at(T0);
  const stopped = await h.daemon.stop({ force: true });

  assert.equal(stopped.ok, true);
  assert.deepEqual(h.asked, [], "force does not go through the polite path");
  assert.deepEqual(h.killed, [{ pid: 777, force: true }]);
  assert.equal(readDiscovery(h.home), undefined);
  h.cleanup();
});

test("a wedged daemon that ignores the polite request still gets stopped", async () => {
  const identity = { pid: 777, startedAtMs: T0 - 5_000 };
  const home = mkdtempSync(join(tmpdir(), "wp26-fd-wedged-"));
  const killed: Array<{ pid: number; force: boolean }> = [];
  const daemon = createFileDaemon({
    home,
    clock: { now: () => T0 },
    launch: { file: process.execPath, args: [] },
    platform: "win32",
    probe: { observe: async (pid) => ({ pid, startedAtMs: identity.startedAtMs }) },
    kill: async (pid, options) => {
      killed.push({ pid, force: options.force });
    },
    requestStop: async () => {
      // A wedged daemon ignores the polite path. Somebody has to be able to stop it,
      // or there is no way to start a new one.
      throw new Error("the daemon did not respond");
    },
    tickIntervalMs: 1_000,
  });

  writeDiscovery(home, identity);
  writeHeartbeat(home, { lastTickAtMs: T0, firedCount: 0 });
  const stopped = await daemon.stop({});

  assert.equal(stopped.ok, true);
  // Falls through to the forceful path rather than reporting a stop that did not happen.
  assert.deepEqual(killed, [{ pid: 777, force: false }]);
  rmSync(home, { recursive: true, force: true });
});

test("clear removes a stale record so a fresh daemon may start", async () => {
  const h = harness(new Map());

  writeDiscovery(h.home, { pid: 777, startedAtMs: T0 - 5_000 });
  assert.notEqual(readDiscovery(h.home), undefined);
  const cleared = await h.daemon.clear();

  assert.equal(cleared.ok, true);
  assert.equal(readDiscovery(h.home), undefined);
  // And a start is now permitted.
  const started = await h.daemon.start();

  // The refusal that was there before must be gone... and what replaces it is the
  // new contract: this launch is a bare `node` with no script, so it never
  // advertises, and `start` says so instead of handing back a happy pid.
  assert.equal(started.ok, false);

  if (started.ok) return;

  assert.equal(started.code, "spawn_failed");
  assert.match(started.message, /did not advertise itself as pid/);
  assert.match(started.message, /daemon\.log/);
  h.cleanup();
});

test("the discovery file is written atomically, so a reader never sees half of it", async () => {
  const h = harness(new Map());
  const identity = { pid: 777, startedAtMs: T0 - 5_000 };

  writeDiscovery(h.home, identity);
  // One line, valid JSON: a partially-written record would fail to decode and the
  // daemon would read as stopped while it is running.
  const raw = readFileSync(join(h.home, "daemon", "daemon.json"), "utf8");

  assert.doesNotThrow(() => JSON.parse(raw));
  assert.equal(raw.split("\n").filter((line) => line.trim().length > 0).length, 1);
  assert.deepEqual(readDiscovery(h.home), identity);
  clearDiscovery(h.home);
  assert.equal(readDiscovery(h.home), undefined);
  h.cleanup();
});

test("a corrupt discovery record reads as absent rather than crashing the reader", () => {
  const home = mkdtempSync(join(tmpdir(), "wp26-fd-corrupt-"));

  mkdirSync(join(home, "daemon"), { recursive: true });
  const file = join(home, "daemon", "daemon.json");

  writeFileSync(file, "{ not json", "utf8");
  // A corrupt record must not become a fabricated identity, and must not throw on
  // the path a status check takes.
  assert.equal(readDiscovery(home), undefined);
  rmSync(home, { recursive: true, force: true });
});
