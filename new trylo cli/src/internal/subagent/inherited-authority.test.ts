import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../adapters/sandbox/index.js";
import { createWorkspaceTools } from "../adapters/tools/index.js";
import { createFixtureProvider } from "../adapters/provider/fixture.js";
import { buildPermissionAction, createPermissionGrantCache } from "../loop/permission-grants.js";
import type { ExecPolicyGuard } from "../loop/tool-admission.js";
import { buildSubagentPorts } from "../surface/cli/wiring-subagent.js";

for (const mode of ["approved", "missing", "different", "policy-denied", "late-approved", "revoked"] as const) {
  test(`production child authority: ${mode} exact-call grant`, async t => {
    const root = mkdtempSync(join(tmpdir(), "trylo-child-grants-"));
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root, mode: "workspace_write" });
    const tools = createWorkspaceTools({ workspaceRoot: root, sandbox });
    const args = { path: "proof.txt", content: "approved child effect" };
    const grants = createPermissionGrantCache();
    if (mode !== "missing" && mode !== "late-approved") grants.record(buildPermissionAction("parent", "write_file",
      mode === "different" ? { ...args, content: "different approved content" } : args), "approved", "session");
    let approvals = 0;
    const execPolicy: ExecPolicyGuard = mode === "policy-denied"
      ? () => ({ kind: "denied", code: "exec_policy_forbidden", message: "operator denied" }) : () => undefined;
    const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, sandbox, model: "test", callerMessages: undefined,
      childProvider: createFixtureProvider({ providerId: "fixture", toolName: "write_file", toolCallId: "child-write", toolArguments: args }),
      ...{ grants, execPolicy }, permission: { request: async action => { approvals += 1; return { ticketId: "unexpected", toolCallId: action.toolCallId }; },
        awaitDecision: async () => ({ resolution: "approved", scope: "session" }) } });
    t.after(async () => { await built.runtime.cancelAll(); rmSync(root, { recursive: true, force: true }); });
    if (mode === "late-approved") grants.record(buildPermissionAction("late-parent", "write_file", args), "approved", "session");
    if (mode === "revoked") grants.clear();
    const spawned = await built.tools.execute({ name: "spawn_agent", toolCallId: "spawn", arguments: { message: "write proof" } }, new AbortController().signal);
    assert.equal(spawned.outcome, "result");
    if (spawned.outcome !== "result") return;
    const id = String(spawned.value["agent_id"]);
    await built.tools.execute({ name: "wait_agent", toolCallId: "wait", arguments: { targets: [id], timeout_ms: 1000, release_on_ready: true } }, new AbortController().signal);
    assert.equal(approvals, 0, "a child may consume an existing grant but cannot ask the user for a new one");
    const allowed = mode === "approved" || mode === "late-approved";
    assert.equal(existsSync(join(root, "proof.txt")), allowed);
    if (allowed) assert.equal(readFileSync(join(root, "proof.txt"), "utf8"), args.content);
    assert.equal(grants.entries().length, mode === "missing" || mode === "revoked" ? 0 : 1, "the child must not add or erase parent decisions");
  });
}
