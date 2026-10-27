import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { permissionPattern, type PermissionAction } from "../../ports/permission.js";
import { inheritedPermission } from "../../subagent/inherited-authority.js";
import { createPlannedPermission, planPermissions } from "./permission-plan.js";
import { automaticWorkspaceWriteAllowed } from "./workspace-write-approval.js";

test("inherited automatic editing authorizes ordinary targets without opening an approval channel", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "team-permission-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  let prompts = 0;
  const parent = createPlannedPermission(planPermissions({ ask: "always", workspaceEdits: "auto", interactive: true }),
    { prompt: () => { prompts += 1; }, readLine: async () => "n" }, action => automaticWorkspaceWriteAllowed(root, action));
  const child = inheritedPermission(parent);
  assert.equal(parent.inheritance?.canUseTool("write_file"), true);
  assert.equal(parent.inheritance?.canUseTool("run_shell"), false);
  for (const [target, expected] of [["result.md", "approved"], [".env", "denied"],
    [".trylo/team/profile.json", "denied"], ["../outside.md", "denied"], ["credentials.json", "denied"]] as const) {
    const args = { path: target, content: "test" };
    const action: PermissionAction = { name: "write_file", toolCallId: target, arguments: args, pattern: permissionPattern("write_file", args) };
    const ticket = await child.request(action);
    assert.equal((await child.awaitDecision(ticket.ticketId)).resolution, expected);
  }
  assert.equal(prompts, 0);
  const deletion = { patch: "*** Begin Patch\n*** Delete File: result.md\n*** End Patch" };
  assert.equal(automaticWorkspaceWriteAllowed(root, { name: "apply_patch", toolCallId: "delete", arguments: deletion,
    pattern: permissionPattern("apply_patch", deletion) }), false);
});
