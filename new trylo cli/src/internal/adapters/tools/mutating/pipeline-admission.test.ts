import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createMutatingTools } from "./index.js";
import { startShellPipeline } from "./shell-child-processes.js";

test("a NUL argument in any pipeline stage is rejected before starting the producer", () => {
  let starts = 0;
  assert.throws(() => startShellPipeline([
    { kind: "direct", argv: ["node", "producer.js"] },
    { kind: "direct", argv: ["node", "bad\0argument"] },
  ], () => { starts += 1; throw new Error("spawn_attempted"); }));
  assert.equal(starts, 0, "invalid later argv must not leave an already-started producer behind");
});

test("command, steps and pipeTo containing NUL fail admission before any tool spawn", async () => {
  let starts = 0;
  const tools = createMutatingTools({ sandbox: createWorkspaceSandbox({ workspaceRoot: tmpdir() }), spawner: async () => {
    starts += 1;
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false, truncated: false };
  } });
  for (const args of [{ command: "node bad\0arg" }, { command: "node first.js", steps: ["node bad\0arg"] },
    { command: "node first.js", pipeTo: "node bad\0arg" }]) {
    const result = await tools.execute({ name: "run_shell", toolCallId: "nul", arguments: args }, new AbortController().signal);
    assert.equal(result.outcome, "error", JSON.stringify(result));
    if (result.outcome === "error") assert.equal(result.code, "invalid_arguments");
  }
  assert.equal(starts, 0);
});
