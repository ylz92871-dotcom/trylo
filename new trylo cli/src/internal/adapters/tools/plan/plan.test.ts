import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlanTools } from "./index.js";
import { createWorkspaceTools } from "../index.js";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { resolvePlanApproval } from "../../../domain/plan-mode.js";
import type { ToolCallRequest } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";

function call(toolCallId: string, name: string, args: JsonObject = {}): ToolCallRequest {
  return { toolCallId, name, arguments: args };
}

function resultValue(outcome: unknown): JsonObject {
  assert.equal((outcome as { outcome: string }).outcome, "result");
  return (outcome as { outcome: "result"; value: JsonObject }).value;
}

test("enter then submit parks in awaiting_approval; no tool path resolves it", async () => {
  const port = createPlanTools({ turnId: "turn-7" });
  const signal = new AbortController().signal;
  const outside = await port.execute(call("t0", "exit_plan_mode", { plan: "do things" }), signal);

  assert.equal(outside.outcome, "error");

  const entered = await port.execute(call("t1", "enter_plan_mode"), signal);

  assert.equal(entered.outcome, "result");

  const secondEnter = await port.execute(call("t2", "enter_plan_mode"), signal);

  assert.equal(secondEnter.outcome, "error");

  const submitted = await port.execute(call("t3", "exit_plan_mode", { plan: "migrate in three steps" }), signal);

  assert.equal(resultValue(submitted)["mode"], "awaiting_approval");

  // B1: there is no resolve binding in the catalog and none in execute.
  // Naming it anyway answers unknown, never a state move.
  const names = port.snapshot().map((binding) => binding.name);

  assert.equal(names.includes("resolve_plan_approval"), false);
  const selfApproval = await port.execute(call("t4", "resolve_plan_approval", { verdict: "approved" }), signal);

  assert.equal(selfApproval.outcome, "unknown");

  // The domain transition itself still works — through the host cell in
  // production (WP23), here directly.
  const approved = resolvePlanApproval({ kind: "awaiting_approval", planText: "migrate in three steps" }, "approved");

  assert.equal(approved.ok, true);
});

test("rejection returns to planning; approval without a plan is refused", async () => {
  const stray = resolvePlanApproval({ kind: "working" }, "approved");

  assert.equal(stray.ok, false);

  const rejected = resolvePlanApproval(
    { kind: "awaiting_approval", planText: "first draft" },
    "rejected",
  );

  assert.equal(rejected.ok, true);
  assert.equal((rejected as { ok: true; state: { kind: string } }).state.kind, "plan");
});

test("update_plan replaces whole and refuses plan mode and double-live steps", async () => {
  const port = createPlanTools({ turnId: "turn-9" });
  const signal = new AbortController().signal;
  const first = await port.execute(
    call("t1", "update_plan", {
      plan: [
        { step: "explore", status: "completed" },
        { step: "write", status: "in_progress" },
      ],
    }),
    signal,
  );

  assert.equal(first.outcome, "result");

  const doubleLive = await port.execute(
    call("t2", "update_plan", {
      plan: [
        { step: "a", status: "in_progress" },
        { step: "b", status: "in_progress" },
      ],
    }),
    signal,
  );

  assert.equal(doubleLive.outcome, "error");

  await port.execute(call("t3", "enter_plan_mode"), signal);
  const inPlan = await port.execute(call("t4", "update_plan", { plan: [{ step: "x", status: "pending" }] }), signal);

  assert.equal(inPlan.outcome, "error");
  assert.equal((inPlan as { outcome: "error"; code: string }).code, "not_allowed_in_plan_mode");
});

test("B2: plan mode refuses workspace mutation with a named code, reads stay open", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-wp21-plan-gate-"));
  try {
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const tools = createWorkspaceTools({ workspaceRoot: root, sandbox });
    const signal = new AbortController().signal;

    const entered = await tools.execute(call("p1", "enter_plan_mode"), signal);

    assert.equal(entered.outcome, "result");

    const write = await tools.execute(
      call("p2", "write_file", { path: "notes.txt", content: "plan-time write" }),
      signal,
    );

    assert.equal(write.outcome, "error");
    assert.equal((write as { outcome: "error"; code: string }).code, "plan_mode_denies_mutation");

    const shell = await tools.execute(call("p3", "run_shell", { command: "echo hi" }), signal);

    assert.equal(shell.outcome, "error");
    assert.equal((shell as { outcome: "error"; code: string }).code, "plan_mode_denies_mutation");

    // Planning itself stays reachable: ask, list, and checklist reads work.
    const listed = await tools.execute(call("p4", "task_list"), signal);

    assert.equal(listed.outcome, "result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
