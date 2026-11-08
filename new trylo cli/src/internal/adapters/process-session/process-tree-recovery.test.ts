import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTreeKillDeps, terminateProcessTree, terminateWindowsTree, type TreeKillDeps } from "./process-tree.js";

for (const outcome of ["exit", "signal", "helper_missing"] as const) {
  test(`Windows observes the original child's ${outcome} while the helper is in flight`, async () => {
    let directKills = 0;
    const child = { pid: 777, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill: () => { directKills += 1; return true; } };
    const deps: TreeKillDeps = { platform: "win32", run: async () => {
      if (outcome === "signal") child.signalCode = "SIGTERM";
      else child.exitCode = 0;
      return outcome === "helper_missing" ? undefined : 255;
    } };
    assert.deepEqual(await terminateProcessTree(child, deps), { ok: true, how: "already_gone" });
    assert.equal(directKills, 0, "a late helper failure must not kill an already-ended root again");
  });
}

test("the Windows entry accepts an observed signal without launching a helper", async () => {
  let helpers = 0;
  const child = { pid: 777, exitCode: null, signalCode: "SIGTERM" as const, kill: () => true };
  assert.deepEqual(await terminateWindowsTree(child, { platform: "win32", run: async () => { helpers += 1; return 255; } }),
    { ok: true, how: "already_gone" });
  assert.equal(helpers, 0);
});

test("a live root still reports the helper's exit 255", async () => {
  const child = { pid: 777, exitCode: null, signalCode: null, kill: () => true };
  const result = await terminateProcessTree(child, { platform: "win32", run: async () => 255 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected refusal");
  assert.equal(result.code, "tree_kill_rejected");
});

test("the default group probe preserves permission errors", t => {
  const failure = Object.assign(new Error("group query denied"), { code: "EPERM" });
  t.mock.method(process, "kill", () => { throw failure; });
  assert.throws(() => defaultTreeKillDeps().groupGone?.(777), error => error === failure);
});

test("the default group probe accepts ESRCH as observed absence", t => {
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  assert.equal(defaultTreeKillDeps().groupGone?.(777), true);
});

test("an unobservable Unix group reports a typed failure without forcing it again", async () => {
  const signals: NodeJS.Signals[] = [];
  const child = { pid: 777, exitCode: null, signalCode: null, kill: () => true };
  const result = await terminateProcessTree(child, { platform: "linux", run: async () => 0,
    signalGroup: (_pid, signal) => { signals.push(signal); },
    groupGone: () => { throw Object.assign(new Error("group query denied"), { code: "EPERM" }); },
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected observation failure");
  assert.equal(result.code, "tree_kill_unobservable");
  assert.match(result.message, /group query denied/);
  assert.deepEqual(signals, ["SIGTERM"]);
});
