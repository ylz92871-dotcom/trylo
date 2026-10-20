import assert from "node:assert/strict";
import { test } from "node:test";
import { describeToolExecution } from "./execution-description.js";
import { RUN_SHELL_BINDING, WRITE_FILE_BINDING } from "./mutating/bindings.js";
import { shellModeFor } from "../../surface/cli/shell-mode-wiring.js";
import { createWorkspaceSandbox } from "../sandbox/index.js";

test("a configured interpreter is advertised without changing schema or static approval", () => {
  const shellMode = { ok: true as const, mode: { kind: "shell" as const, shell: { kind: "powershell" as const, path: "C:/fixture/powershell.exe" } } };
  const binding = describeToolExecution(RUN_SHELL_BINDING, { shellMode });
  assert.match(binding.description, /powershell/);
  assert.match(binding.description, /redirections/);
  assert.equal(binding.parameters, RUN_SHELL_BINDING.parameters);
  assert.equal(binding.needsApproval, true);
  assert.equal(describeToolExecution(WRITE_FILE_BINDING, {}), WRITE_FILE_BINDING);
  assert.match(describeToolExecution(WRITE_FILE_BINDING, { fileAccess: "host" }).description, /scope: host/);
});

test("an explicit none interpreter keeps direct command execution available", () => {
  const shellMode = shellModeFor("none", { platform: "win32", env: {}, fileExists: () => false });
  const sandbox = createWorkspaceSandbox({ workspaceRoot: ".", shellMode });
  assert.equal(sandbox.evaluate({ toolCallId: "direct", name: "run_shell", arguments: { command: "node --version" } }).ok, true);
});
