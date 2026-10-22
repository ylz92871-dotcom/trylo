import assert from "node:assert/strict";
import { test } from "node:test";
import { admitToolCall } from "../../loop/tool-admission.js";
import { createDoomLoopTracker } from "../../loop/doom-loop.js";
import { buildPermissionAction, createPermissionGrantCache } from "../../loop/permission-grants.js";
import { awaitPermissionDecision } from "../../loop/permission-boundary.js";
import { decision, type PermissionDecision, type PermissionPort } from "../../ports/permission.js";
import { createSessionPermissions } from "./session-permissions.js";
import { decideForPlan, planPermissions } from "./permission-plan.js";
import { buildExecPolicyGuard } from "./exec-policy-guard.js";

const CALL = { toolCallId: "audit", name: "run_shell", arguments: { command: "git status" } };

test("a selected session mode overrides startup allowances still forwarded on subsequent turns", () => {
  const startup = { allowTools: ["run_shell"], allowWrites: true };
  const session = createSessionPermissions(startup);
  session.setMode("read-only");
  const plan = planPermissions({ ...session.choice(startup), interactive: true });
  assert.equal(decideForPlan(plan, buildPermissionAction("shell", "run_shell", { command: "git status" })), "denied");
  assert.equal(decideForPlan(plan, buildPermissionAction("write", "write_file", { path: "a", content: "b" })), "denied");
});

test("session tool disable and revoke remain effective in a run started with explicit allowances", () => {
  const startup = { allowTools: ["run_shell"] };
  const session = createSessionPermissions(startup);
  session.denyTool("run_shell");
  let plan = planPermissions({ ...session.choice(startup), interactive: true });
  assert.equal(decideForPlan(plan, buildPermissionAction(CALL.toolCallId, CALL.name, CALL.arguments)), "denied");
  session.revokeTool("run_shell");
  plan = planPermissions({ ...session.choice(startup), interactive: true });
  assert.equal(decideForPlan(plan, buildPermissionAction(CALL.toolCallId, CALL.name, CALL.arguments)), "ask");
});

test("a remembered tool-wide denial outranks an execution-policy allow and repeat detection", async () => {
  for (const usePolicy of [false, true]) {
    const grants = createPermissionGrantCache();
    grants.record(buildPermissionAction(CALL.toolCallId, CALL.name, CALL.arguments), "denied", "session");
    let prompts = 0;
    const permission: PermissionPort = {
      async request(action) { prompts += 1; return { ticketId: "t", toolCallId: action.toolCallId }; },
      async awaitDecision() { return decision("approved"); },
    };
    const ports = { permission, grants, doom: createDoomLoopTracker(1), ...(usePolicy ? { execPolicy: () => ({ kind: "approved" as const }) } : {}) };
    const verdict = await admitToolCall(ports, CALL);
    assert.equal(verdict.kind, "denied", JSON.stringify(verdict));
    assert.equal(prompts, 0, "disabled tools must not be offered for reapproval");
  }
});

test("malformed approved decisions and empty tickets fail closed at the permission boundary", async () => {
  const action = buildPermissionAction(CALL.toolCallId, CALL.name, CALL.arguments);
  const malformed = JSON.parse('{"resolution":"approved","scope":"forever"}') as PermissionDecision;
  const badDecision = await awaitPermissionDecision({ async request() { return { ticketId: "t", toolCallId: action.toolCallId }; }, async awaitDecision() { return malformed; } }, action);
  assert.equal(badDecision.outcome, "failed");
  const badTicket = await awaitPermissionDecision({ async request() { return { ticketId: "", toolCallId: action.toolCallId }; }, async awaitDecision() { return decision("approved"); } }, action);
  assert.equal(badTicket.outcome, "failed");
});

test("exec policy evaluates every sequential command and the explicit pipeTo receiver", () => {
  const result = buildExecPolicyGuard({ workspaceRoot: "D:/CC/trylo", platform: "windows", ask: "always", allowAbsoluteExecutable: false }, {
    rules: [{ pattern: ["git", "status"], decision: "allow" }, { pattern: ["rm"], decision: "forbidden" }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const extra of [{ steps: ["rm victim"] }, { pipeTo: "rm victim" }]) {
    const verdict = result.guard({ ...CALL, arguments: { ...CALL.arguments, ...extra } });
    assert.equal(verdict?.kind, "denied", JSON.stringify(verdict));
  }
  const unmatched = result.guard({ ...CALL, arguments: { ...CALL.arguments, steps: ["node task.js"] } });
  assert.equal(unmatched, undefined, "an allowed head cannot authorize an uncovered later command");
});

test("a configured command policy refuses opaque shell syntax instead of falling through to a tool-wide allow", () => {
  const result = buildExecPolicyGuard({ workspaceRoot: "D:/CC/trylo", platform: "windows", ask: "always", allowAbsoluteExecutable: false }, {
    rules: [{ pattern: ["git", "status"], decision: "allow" }, { pattern: ["rm"], decision: "forbidden" }],
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  const verdict = result.guard({ ...CALL, arguments: { command: "git status; rm victim" } });
  assert.equal(verdict?.kind, "denied", JSON.stringify(verdict));
  if (verdict?.kind === "denied") assert.equal(verdict.code, "exec_policy_unverifiable");
});
