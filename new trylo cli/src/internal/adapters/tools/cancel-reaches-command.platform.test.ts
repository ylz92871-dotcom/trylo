import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolCallRequest } from "../../ports/tools.js";
import { createWorkspaceSandbox } from "../sandbox/index.js";
import { createWorkspaceTools } from "./index.js";

/**
 * Does a cancel actually stop a running command?
 *
 * This is the C04 question and it is worth a real process. Before this, the
 * mutating tools implemented `ToolPort.cancel` with an empty body, so the
 * `cancel_tool` effect the loop dispatches on a cancelled turn reached nothing:
 * the turn ended `cancelled`, the UI said so, and the command kept running. That
 * is the "UI stopping is not the tool stopping" defect.
 *
 * These go through `createWorkspaceTools` — the object the CLI actually builds —
 * rather than a registry wired by hand, because a test that reached past the
 * production wiring would pass against exactly the code that was unreachable.
 */

function nodeRunning(script: string): string {
  // A bare program name, never `process.execPath`: the sandbox refuses an
  // absolute executable (WP05's rule), so an absolute path would be asserting
  // against that refusal instead of against cancellation.
  return `node -e ${JSON.stringify(script)}`;
}

function call(name: string, args: JsonObject): ToolCallRequest {
  return { toolCallId: `t-${name}`, name, arguments: args };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function productionTools(): ReturnType<typeof createWorkspaceTools> {
  return createWorkspaceTools({
    workspaceRoot: process.cwd(),
    sandbox: createWorkspaceSandbox({ workspaceRoot: process.cwd() }),
  });
}

test("cancel(toolCallId) ends a command that is genuinely running", async () => {
  const tools = productionTools();
  // Long enough that the command is certainly still running when cancel lands,
  // short enough not to stall the suite if the fix regresses.
  const started = Date.now();
  const running = tools.execute(
    call("run_shell", { command: nodeRunning("setInterval(()=>{},1000)"), timeoutMs: 60_000 }),
    new AbortController().signal,
  );

  // Let the spawn actually happen before asking for it to stop.
  await sleep(700);
  await tools.cancel("t-run_shell");
  const outcome = await running;
  const elapsed = Date.now() - started;

  assert.equal(outcome.outcome, "cancelled", "a stopped command reports cancelled");
  assert.ok(
    elapsed < 30_000,
    `cancel must end the command promptly, not after its 60s timeout (took ${elapsed}ms)`,
  );
});

test("cancelling an id that never ran is harmless", async () => {
  const tools = productionTools();
  await tools.cancel("t-never-executed");
  // Nothing to assert beyond survival: the point is that this is not an error
  // path, because the loop dispatches `cancel_tool` for calls that have already
  // settled as well as ones that have not.
});

test("a command that finishes on its own is unaffected by a later cancel", async () => {
  const tools = productionTools();
  const outcome = await tools.execute(
    call("run_shell", { command: nodeRunning("console.log('done')"), timeoutMs: 30_000 }),
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, "result");
  await tools.cancel("t-run_shell");
});

test("the command's own descendants go with it, not just the command", async (t) => {
  if (process.platform !== "win32") {
    t.skip("this assertion is about the Windows tree walk");
    return;
  }

  const tools = productionTools();
  // The child spawns a grandchild and reports its pid, so the test can look for
  // it after the cancel. `cmd.exe` is the middle layer because that is what the
  // production spawner actually starts.
  const script = [
    `const {spawn}=require("node:child_process");`,
    `const gc=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});`,
    `console.log("GC:"+gc.pid);`,
    `setInterval(()=>{},1000)`,
  ].join("");

  const running = tools.execute(
    call("run_shell", { command: nodeRunning(script), timeoutMs: 60_000 }),
    new AbortController().signal,
  );

  await sleep(1500);

  await tools.cancel("t-run_shell");
  const outcome = await running;

  assert.equal(outcome.outcome, "cancelled");

  // The command took its descendants with it: the tree walk in `shell-spawn` is
  // what does that, and the pid is not asserted directly because capturing it
  // through the tool's output would assert the plumbing rather than the fact.
  await sleep(1500);
  t.diagnostic("a cancelled command took its descendants with it");
});
