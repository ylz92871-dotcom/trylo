import assert from "node:assert/strict";
import test from "node:test";

import { terminatePidTree } from "./terminate-by-pid.js";
import type { TreeKillDeps } from "./process-tree.js";

/**
 * Killing a pid this process did not spawn (WP26 / A04: `trylo bg kill` from a
 * second terminal).
 *
 * Two facts, pinned separately because they have opposite remedies:
 *
 * - win32 reuses the same `taskkill /T /F` walk the in-process path uses, naming
 *   the pid — one implementation, so one cannot drift from the other.
 * - POSIX refuses outright with `tree_kill_unsupported_platform` and launches no
 *   helper. A group signal (`-pid`) is only safe against a group leader; a pid
 *   read off disk may not be one, and signalling this process's own group would
 *   kill unrelated work. Unimplemented on purpose, and loud about it.
 *
 * Everything here drives the injection seam — no process is ever killed.
 */

function winDeps(
  code: number | undefined,
  calls: Array<{ readonly file: string; readonly args: ReadonlyArray<string> }>,
): TreeKillDeps {
  return {
    platform: "win32",
    run: async (file, args) => {
      calls.push({ file, args: [...args] });
      return code;
    },
  };
}

test("win32 walks the tree with taskkill /T /F and names the pid", async () => {
  const calls: Array<{ readonly file: string; readonly args: ReadonlyArray<string> }> = [];
  const outcome = await terminatePidTree(777, winDeps(0, calls));
  assert.deepEqual(outcome, { ok: true, how: "killed" });
  assert.equal(calls.length, 1, "exactly one helper run");
  assert.equal(calls[0]?.file, "taskkill");
  assert.deepEqual(calls[0]?.args, ["/PID", "777", "/T", "/F"]);
});

test("a POSIX by-pid tree kill is explicitly refused and launches no helper", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    let launched = false;
    const outcome = await terminatePidTree(555, {
      platform,
      run: async () => {
        launched = true;
        return 0;
      },
    });

    assert.equal(outcome.ok, false, `${platform} must not claim the tree died`);

    if (outcome.ok) throw new Error("expected failure");

    assert.equal(outcome.code, "tree_kill_unsupported_platform");
    assert.match(outcome.message, /tree-killed by pid/);
    assert.match(outcome.message, new RegExp(platform));
    assert.equal(launched, false, "no helper may run on a platform with no walk");
  }
});
