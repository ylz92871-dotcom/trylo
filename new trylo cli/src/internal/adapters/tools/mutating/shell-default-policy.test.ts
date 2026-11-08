import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxPolicy } from "../../sandbox/policy.js";
import { planMutation } from "../../sandbox/planner.js";
import { executeShell } from "./shell-tool.js";

for (const timeoutMs of [undefined, 600_000]) {
  test(`shell execution preserves ${timeoutMs === undefined ? "an omitted deadline" : "a caller deadline beyond two minutes"}`, async () => {
    const call = { toolCallId: "long", name: "run_shell", arguments: {
      command: "node build.mjs", ...(timeoutMs === undefined ? {} : { timeoutMs }),
    } };
    const planned = planMutation(createSandboxPolicy({ workspaceRoot: process.cwd() }), call);

    assert.ok(planned.ok);

    if (!planned.ok) return;

    let called = false;
    const outcome = await executeShell({ spawner: async spec => {
      called = true;
      assert.equal(spec.timeoutMs, timeoutMs);
      return { exitCode: 0, stdout: "built", stderr: "", timedOut: false, aborted: false, truncated: false };
    } }, call, planned.plan, new AbortController().signal);

    assert.equal(called, true);
    assert.equal(outcome.outcome, "result");
  });
}
