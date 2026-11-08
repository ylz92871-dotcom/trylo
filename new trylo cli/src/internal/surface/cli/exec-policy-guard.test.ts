import assert from "node:assert/strict";
import { test } from "node:test";
import { admitToolCall, type AdmissionPorts } from "../../loop/tool-admission.js";
import { createDoomLoopTracker } from "../../loop/doom-loop.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { decision, type PermissionPort } from "../../ports/permission.js";
import type { ToolAdmissionRequest } from "../../loop/tool-admission.js";
import { buildExecPolicyGuard, type ExecPolicyGuardConfig } from "./exec-policy-guard.js";
import { RUN_SHELL_TOOL } from "../../adapters/tools/mutating/names.js";

/**
 * The wiring, not just the evaluator (C66/L64).
 *
 * Each test enters through `admitToolCall` — the same door the loop uses — and
 * counts how often the permission port was consulted. A policy that answers with
 * silence must ask the human exactly as often as it did before this existed.
 */

const CONFIG: ExecPolicyGuardConfig = {
  platform: "windows",
  ask: "always",
  workspaceRoot: "D:/CC/trylo",
  allowAbsoluteExecutable: false,
};

function countingPermission(): PermissionPort & { asked(): number } {
  let asked = 0;
  return {
    asked: () => asked,

    async request() {
      asked += 1;
      return { ticketId: `t${asked}`, toolCallId: "call-1" };
    },

    async awaitDecision() {
      return decision("approved", "once");
    },
  };
}

function call(command: string): ToolAdmissionRequest {
  return { toolCallId: "call-1", name: RUN_SHELL_TOOL, arguments: { command } };
}

async function decideWithGuard(command: string, rules: Parameters<typeof buildExecPolicyGuard>[1]) {
  const built = buildExecPolicyGuard(CONFIG, rules);

  assert.equal(built.ok, true, "the policy used by these tests must load");

  if (!built.ok) {
    throw new Error("policy did not load");
  }

  const permission = countingPermission();
  const ports: AdmissionPorts = {
    permission,
    grants: createPermissionGrantCache(),
    doom: createDoomLoopTracker(),
    execPolicy: built.guard,
  };
  const verdict = await admitToolCall(ports, call(command));

  return { verdict, permission };
}

const SOURCE = {
  rules: [
    {
      pattern: ["rm", "-rf"],
      decision: "forbidden",
      justification: "force delete has no undo",
      match: [["rm", "-rf", "/tmp/x"]],
    },
    { pattern: ["git", "status"], decision: "allow", match: [["git", "status"]] },
  ],
};

test("a written refusal ends the call and never reaches a human", async () => {
  const { verdict, permission } = await decideWithGuard("rm -rf /tmp/example", SOURCE);
  assert.deepEqual(
    verdict.kind === "policy_rejected" ? { kind: verdict.kind, code: verdict.code } : verdict,
    { kind: "policy_rejected", code: "exec_policy_forbidden" },
  );
  assert.equal(permission.asked(), 0, "asking about a forbidden command implies it might be allowed");
});

test("a written allowance runs, and says why it ran", async () => {
  const { verdict, permission } = await decideWithGuard("git status --short", SOURCE);
  assert.deepEqual(verdict, { kind: "approved", source: "policy" });
  assert.equal(permission.asked(), 0);
});

test("the policy stays silent about anything it does not cover", async () => {
  const { verdict, permission } = await decideWithGuard("cargo build", SOURCE);
  assert.equal(verdict.kind, "approved");
  assert.equal(permission.asked(), 1, "uncovered commands still go to whoever was going to be asked");
});

test("silence covers tools that carry no command at all", async () => {
  const built = buildExecPolicyGuard(CONFIG, SOURCE);

  assert.equal(built.ok, true);

  if (!built.ok) {
    return;
  }

  assert.equal(built.guard({ toolCallId: "c", name: "write_file", arguments: { path: "a.txt" } }), undefined);
  assert.equal(built.guard({ toolCallId: "c", name: RUN_SHELL_TOOL, arguments: {} }), undefined);
});

test("an unmatched dangerous command is still put to a human", async () => {
  const { verdict, permission } = await decideWithGuard("rm -rf 'a b'", {
    rules: [{ pattern: ["git"], decision: "allow", match: [["git"]] }],
  });
  assert.equal(verdict.kind, "approved");
  assert.equal(permission.asked(), 1, "danger with no rule is not permission");
});

test("a pipeline is only as admissible as its least admissible half", async () => {
  const { verdict } = await decideWithGuard("git status | rm -rf /tmp/x", SOURCE);
  assert.deepEqual(
    verdict.kind === "policy_rejected" ? verdict.kind : verdict,
    "policy_rejected",
  );
});

test("a policy that does not load is refused rather than installed", () => {
  // Note that examples obey prefix semantics: `["ls", "--missing"]` *is* matched
  // by a rule for `ls`, so it is a valid example and not a failing one. What
  // must fail is an example the rule's own first token cannot even be reached by.
  const built = buildExecPolicyGuard(CONFIG, {
    rules: [{ pattern: ["ls"], decision: "allow", match: [["cat", "missing"]] }],
  });

  assert.equal(built.ok, false);

  if (built.ok) {
    return;
  }

  assert.match(built.failures[0]?.message ?? "", /is not matched by this rule/);
});
