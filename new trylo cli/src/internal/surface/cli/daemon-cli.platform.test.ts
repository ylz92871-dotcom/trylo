import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * `trylo daemon start|status|stop` as a person actually runs it: a real child
 * process, a real binary, nothing injected.
 *
 * ## Why this file exists
 *
 * The daemon's lifecycle was verified end-to-end — six processes racing one
 * lease, a spawn that survives its parent, a stop that works — and every one of
 * those probes either imported `daemon-main.js` itself or handed `createFileDaemon`
 * a launch config. None of them ran the command. Two defects lived through that:
 *
 *  1. the default launch target pointed two directories short, so `start`
 *     reported "spawned as pid N" for a child that died immediately; and
 *  2. the spawn never called `child.unref()`, so once the target was fixed and a
 *     real daemon stayed alive, **`trylo daemon start` never returned** — it hung
 *     holding the child handle until it was killed.
 *
 * Both are invisible from inside the adapter and obvious from the CLI, which is
 * the layer this test sits in.
 *
 * ## The one deadline
 *
 * `spawnSync` gets a timeout so a regression in direction (2) fails with an
 * error instead of hanging the gate forever. The deadline is generous (20s) and
 * only ever reached by broken code; a working `start` returns in well under a
 * second. Nothing here sleeps to make a passing case pass — the polling loop
 * below only waits for the daemon's own discovery record.
 */

const CLI = fileURLToPath(new URL("../../../cmd/trylo/main.js", import.meta.url));
const DEADLINE_MS = 20_000;

function trylo(env: Record<string, string>, ...argv: string[]) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: DEADLINE_MS,
    windowsHide: true,
  });
}

function statusOf(env: Record<string, string>): string {
  const run = trylo(env, "daemon", "status", "--json");
  if (run.error !== undefined) {
    assert.fail(`daemon status must return: ${run.error.message}`);
  }
  const parsed = JSON.parse(run.stdout.trim()) as { readonly status: string };
  return parsed.status;
}

test("the daemon answers to the real CLI, and the command returns", () => {
  const home = join(mkdtempSync(join(tmpdir(), "trylo-daemon-cli-")), "h");
  const env = { TRYLO_HOME: home };
  const stopBestEffort = () => {
    // Cleanup, not a contract: if the daemon is already gone this answers
    // `not_running` and there is nothing left to do. The assertions below are
    // what decide whether this test passes.
    try {
      trylo(env, "daemon", "stop", "--force");
    } catch {
      // A failed best-effort cleanup must not replace the real failure.
    }
  };

  try {
    const started = trylo(env, "daemon", "start");

    assert.equal(started.error, undefined, `daemon start did not return within ${DEADLINE_MS}ms: ${started.error?.message}`);
    assert.equal(started.status, 0, `stderr: ${started.stderr}`);
    const pid = /running as pid (\d+)/.exec(started.stdout)?.[1];

    assert.notEqual(pid, undefined, `start did not confirm a running pid; stdout: ${started.stdout} stderr: ${started.stderr}`);

    // The point of the first defect: a pid is not a daemon. `status` is how a
    // person finds out, so it has to say running for a daemon that really runs.
    let seen = statusOf(env);

    for (let tries = 0; tries < 30 && seen !== "running"; tries += 1) {
      // Bounded wait for the daemon's own discovery record; the failing case
      // still fails, it just fails after 30 tries.
      sleep(300);
      seen = statusOf(env);
    }

    assert.equal(seen, "running", "spawned a pid but nothing is running — the launch target is dead");

    stopBestEffort();
    assert.equal(statusOf(env), "stopped", "a force-stopped daemon must answer stopped");
  } finally {
    stopBestEffort();
  }
});

/** A real sleep, used only inside the bounded wait above. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
