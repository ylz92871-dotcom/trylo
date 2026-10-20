import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { createPlannedPermission, planPermissions } from "./permission-plan.js";
import { createSessionPermissions } from "./session-permissions.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { restrictDeniedTools } from "./permission-tool-access.js";

test("external readers can be explicitly approved and explicit denials govern local dispatch too", async () => {
  assert.equal(parseArgs(["run", "--filesystem-access", "reviewed", "--allow-tools", "read_file,view_image", "hello"]).kind, "run");
  const root = await mkdtemp(path.join(tmpdir(), "trylo-denied-reader-"));
  try {
    await writeFile(path.join(root, "private.txt"), "private");
    const port = createPlannedPermission(planPermissions({ interactive: false, allowTools: ["read_file"], denyTools: ["read_file"] }),
      { prompt() {}, async readLine() { throw new Error("denied policy must not prompt"); } });
    const tools = restrictDeniedTools(createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }) }), port);
    assert.equal(tools.snapshot().some(binding => binding.name === "read_file"), true, "static existence is not an execution grant");
    const result = await tools.execute({ toolCallId: "read", name: "read_file", arguments: { path: "private.txt" } }, new AbortController().signal);
    assert.equal(result.outcome, "error");
    if (result.outcome === "error") assert.equal(result.code, "permission_denied");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session read-only still exposes workspace readers and refuses external approval", () => {
  const session = createSessionPermissions(); session.setMode("read-only");
  const choice = session.choice({});
  assert.equal(choice.ask, "never");
  assert.equal(choice.denyTools?.includes("read_file"), false);
  assert.ok(choice.denyTools?.includes("write_file")); session.close();
});
