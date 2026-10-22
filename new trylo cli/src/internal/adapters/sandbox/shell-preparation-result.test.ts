import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsShellBoundary } from "./windows-shell-boundary.js";
import { createWorkspaceSandbox } from "./index.js";
import { createWorkspaceTools } from "../tools/index.js";

test("sandbox preparation failure is distinct from a denied tool or broken command and never falls back", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-shell-preparation-"));
  let preparations = 0;
  const boundary = createWindowsShellBoundary(root, { LOCALAPPDATA: root }, async () => {
    preparations += 1;
    throw new Error("fixture helper cannot acquire its required privilege");
  });
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox,
    spawner: boundary.spawner(async () => assert.fail("no command may start through a failed boundary")) });
  try {
    for (let index = 0; index < 2; index += 1) {
      const result = await tools.execute({ toolCallId: `s-${index}`, name: "run_shell",
        arguments: { command: 'node -e "console.log(1)"' } }, new AbortController().signal);
      assert.equal(result.outcome, "error");
      if (result.outcome !== "error") return;
      assert.equal(result.code, "isolation_preparation_failed");
      assert.match(result.message, /Do not retry.*session/);
    }
    assert.equal(preparations, 1);
  } finally {
    await boundary.close();
    rmSync(root, { recursive: true, force: true });
  }
});
