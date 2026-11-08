import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminateProcessTree } from "./process-tree.js";

/**
 * The real thing: does the tree actually go away on this machine?
 *
 * Everything else about this module can be asserted with a fake child. This file
 * exists because the point of C13 is a *machine* fact — a descendant that
 * outlives a direct-child kill — and only a real process tree shows it.
 *
 * # The shape matters, and it was measured rather than assumed
 *
 * The direct child is `cmd.exe`, because that is what `run_shell` actually
 * spawns (`shell-spawn.ts` → `spawn(cmd.exe, ["/c", ...])`). A first attempt used
 * `node` as the direct child and the grandchild died with it, which would have
 * made this file assert a defect production does not have.
 * `evidence/2026-10-05-WP07/04-tree-shape-comparison.log` measures both:
 *
 *   node-parent: grandchild alive after a direct kill = false   ← not production
 *   cmd-parent:  grandchild alive after a direct kill = true    ← production shape
 *
 * So the baseline is recorded as a *diagnostic* and never as an assertion that
 * the defect exists — a future Windows release may close it, and this file must
 * not fail when it does.
 *
 * # Every process this file starts, it stops
 *
 * The first version leaked. A surviving descendant inherits the stdout pipe, so
 * the node test runner's event loop never drained and the file died on the suite
 * timeout with three green tests and a red file. Each helper below therefore
 * reports the *middle* process too, and `finally` ends whatever is left — a test
 * that leaves processes behind also stalls whoever runs the suite next.
 */

function listedInTasklist(pid: number): boolean {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
    return out.toLowerCase().includes(String(pid));
  } catch {
    return false;
  }
}

type Shape = {
  child: ChildProcess;
  /** `cmd.exe` — what `terminateProcessTree` is given. */
  shellPid: number;
  /** The `node parent.cjs` in the middle; survives a direct kill. */
  middlePid: Promise<number>;
  /** The `node` at the bottom; the descendant under test. */
  grandchildPid: Promise<number>;
};

/** `cmd.exe` → `node` → `node`, the three levels `run_shell` really produces. */
function spawnProductionShape(dir: string, marker: string, delayMs: number): Shape {
  const grandchildSource = `setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(marker)},"descendant acted")},${delayMs})`;
  const parentScript = [
    `const {spawn}=require("node:child_process");`,
    `console.log("P:"+process.pid);`,
    `const gc=spawn(process.execPath,["-e",${JSON.stringify(grandchildSource)}],{stdio:"ignore"});`,
    `console.log("GC:"+gc.pid);`,
    `setInterval(()=>{},1000)`,
  ].join("");
  const parentFile = path.join(dir, "wp07-parent.cjs");

  writeFileSync(parentFile, parentScript, "utf8");

  // Verbatim arguments, the same way `shell-spawn.ts` spawns a `shell` shape —
  // otherwise cmd.exe re-parses the quoting and the child never starts.
  const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", `node ${parentFile}`], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsVerbatimArguments: true,
  });

  const read = (marker: string): Promise<number> =>
    new Promise((resolve) => {
      let buf = "";

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        const match = new RegExp(`${marker}:(\\d+)`).exec(buf);
        if (match?.[1] !== undefined) resolve(Number(match[1]));
      });
      setTimeout(() => resolve(0), 8000);
    });

  return {
    child,
    shellPid: child.pid ?? 0,
    middlePid: read("P"),
    grandchildPid: read("GC"),
  };
}

/** End anything still standing. Best effort by design — this is cleanup. */
function forceEnd(pid: number): void {
  if (pid <= 0 || !listedInTasklist(pid)) {
    return;
  }
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // Already gone between the check and the kill.
  }
}

test("BASELINE (diagnostic, never fails): a direct-child kill leaves the production-shape grandchild running", async (t) => {
  if (process.platform !== "win32") {
    t.skip("this observation is about Windows tree semantics");
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "trylo-wp07-base-"));
  const middle = { pid: 0 };
  let grandchild = 0;

  try {
    const shape = spawnProductionShape(dir, path.join(dir, "acted.txt"), 4000);

    grandchild = await shape.grandchildPid;
    middle.pid = await shape.middlePid;
    assert.ok(grandchild > 0, "the probe must actually start a descendant");

    await new Promise((resolve) => setTimeout(resolve, 400));
    shape.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    t.diagnostic(
      `direct-child kill left the grandchild running: ${listedInTasklist(grandchild)} (the C13 defect on this machine)`,
    );
  } finally {
    // The middle process is the one that outlives the kill and holds the pipe.
    forceEnd(middle.pid);
    forceEnd(grandchild);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminateProcessTree leaves no descendant running and none able to act", async (t) => {
  if (process.platform !== "win32") {
    t.skip("this assertion is about the Windows tree walk");
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "trylo-wp07-tree-"));
  const marker = path.join(dir, "acted-after-kill.txt");
  let middle = 0;
  let grandchild = 0;

  try {
    // The descendant acts at 5s; we check at 8s, so a survivor cannot hide.
    const shape = spawnProductionShape(dir, marker, 5000);

    grandchild = await shape.grandchildPid;
    middle = await shape.middlePid;
    assert.ok(grandchild > 0, "the probe must actually start a descendant");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(listedInTasklist(grandchild), true, "descendant must be running before the walk");

    const outcome = await terminateProcessTree(shape.child);

    assert.equal(outcome.ok, true, `tree walk failed: ${JSON.stringify(outcome)}`);

    await new Promise((resolve) => setTimeout(resolve, 8000));
    assert.equal(listedInTasklist(grandchild), false, "a descendant is still running under the stopped tree");
    assert.equal(existsSync(marker), false, "a surviving descendant went on to act");
  } finally {
    forceEnd(middle);
    forceEnd(grandchild);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping a process that already ended is already_gone, not an error", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const outcome = await terminateProcessTree(child);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.how, "already_gone");
});
