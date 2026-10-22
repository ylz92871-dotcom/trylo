import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createNodeSpawner } from "../../adapters/tools/mutating/shell-spawn.js";
import { createFakeProvider, createFakePermission, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn, type LoopPorts } from "../../loop/runner.js";
import type { ExecPolicyGuard } from "../../loop/tool-admission.js";

test("the real loop consumes a configured command policy before an approved shell can spawn", async t => {
  const root = mkdtempSync(join(tmpdir(), "trylo-policy-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "marker.cjs"), "require('node:fs').writeFileSync('must-not-exist.txt','started')");
  let starts = 0;
  const spawn = createNodeSpawner();
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox, spawner: spec => { starts += 1; return spawn(spec); } });
  const ports: LoopPorts & { readonly execPolicy: ExecPolicyGuard } = {
    provider: createFakeProvider([
      [{ type: "tool_call", toolCallId: "shell", name: "run_shell", arguments: { command: "node marker.cjs" } },
        { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true }],
      [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
    ]), tools, sandbox, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    execPolicy: () => ({ kind: "denied", code: "exec_policy_forbidden", message: "this command is forbidden" }),
  };
  await runTurn(ports, { sessionId: "policy-audit", turnId: "turn", correlationId: "cor", text: "audit" });
  assert.deepEqual({ starts, markerExists: existsSync(join(root, "must-not-exist.txt")) }, { starts: 0, markerExists: false });
});
