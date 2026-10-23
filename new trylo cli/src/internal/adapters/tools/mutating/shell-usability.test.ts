import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { createSandboxPolicy, DEFAULT_SHELL_TIMEOUT_MS } from "../../sandbox/policy.js";
import { executeShell } from "./shell-tool.js";
import { planMutation } from "../../sandbox/planner.js";
import type { ShellModeResult } from "../../sandbox/shell-mode.js";
import { toolCatalogHash, compatibleCatalogHashes } from "../../../surface/cli/wiring-catalog.js";
import { createWorkspaceTools } from "../index.js";
import { createProcessSessionRegistry } from "../../process-session/session-registry.js";

const root = process.cwd();
const signal = new AbortController().signal;
const direct = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
const mode: ShellModeResult = { ok: true, mode: { kind: "shell", shell: { kind: "powershell", path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" } } };
const shelled = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root, shellMode: mode }), shellMode: mode });

test("the model is told the active command language without changing its session identity", () => {
  const description = shelled.snapshot().find(binding => binding.name === "run_shell")?.description;
  assert.match(description ?? "", /powershell/i);
  assert.doesNotMatch(description ?? "", /with no shell|without redirections/i);
  assert.match(description ?? "", /steps.*pipeTo.*(?:unavailable|not supported|do not)/i);
  assert.match(direct.snapshot().find(binding => binding.name === "run_shell")?.description ?? "", /no shell|direct/i);
  assert.equal(toolCatalogHash(direct), toolCatalogHash(shelled));
});

test("a missing requested interpreter is advertised as unavailable before the first tool call", () => {
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
    shellMode: { ok: false, code: "shell_not_installed", message: "missing" } });
  assert.match(tools.snapshot().find(binding => binding.name === "run_shell")?.description ?? "", /shell_not_installed/);
});

test("routine commands get a documented 60 second foreground default", async () => {
  const call = { toolCallId: "default", name: "run_shell", arguments: { command: "node build.mjs" } };
  const planned = planMutation(createSandboxPolicy({ workspaceRoot: root }), call);
  assert.ok(planned.ok);
  if (!planned.ok) return;
  let observed = 0;
  await executeShell({ spawner: async spec => { observed = spec.timeoutMs; return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, aborted: false, truncated: false }; } }, call, planned.plan, signal);
  assert.equal(observed, 60_000);
  assert.equal(DEFAULT_SHELL_TIMEOUT_MS, observed);
  const binding = direct.snapshot().find(binding => binding.name === "run_shell");
  assert.equal(binding?.timeoutMs, observed);
  assert.match(binding?.description ?? "", /60000/);
  assert.match(binding?.description ?? "", /runInBackground/);
});

for (const failure of ["timeout", "nonzero"] as const) test(`a ${failure} after a successful step reports what ran and what did not`, async () => {
  const call = { toolCallId: failure, name: "run_shell", arguments: { command: "node prepare.mjs", steps: ["node import.mjs", "node publish.mjs"], timeoutMs: 1000 } };
  const planned = planMutation(createSandboxPolicy({ workspaceRoot: root }), call);
  assert.ok(planned.ok);
  if (!planned.ok) return;
  let calls = 0;
  const outcome = await executeShell({ spawner: async () => { calls++; return calls === 1
    ? { exitCode: 0, stdout: "PREPARED", stderr: "", timedOut: false, aborted: false, truncated: false }
    : { exitCode: 7, stdout: "IMPORTED HALF", stderr: "", timedOut: failure === "timeout", aborted: false, truncated: false }; } }, call, planned.plan, signal);
  assert.equal(calls, 2);
  assert.equal(outcome.outcome, "error");
  if (outcome.outcome !== "error") return;
  assert.match(outcome.message, /1 prior steps? completed/i);
  assert.match(outcome.message, /import\.mjs/);
  assert.match(outcome.message, /later steps were not run/i);
  assert.match(outcome.message, /partial effects/i);
  assert.match(outcome.message, /PREPARED/);
  assert.match(outcome.message, /IMPORTED HALF/);
});

test("clarifying shell documentation admits the previous exact parameter contract on resume", () => {
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }), sessions: createProcessSessionRegistry() });
  const legacy = { ...tools, snapshot: () => tools.snapshot().map(binding => {
    if (binding.name !== "run_shell") return binding;
    const properties = binding.parameters.properties;
    assert.ok(properties !== null && typeof properties === "object" && !Array.isArray(properties));
    return { ...binding, parameters: { ...binding.parameters, properties: { ...properties,
      command: { type: "string", description: "Command to run, without redirections. `a | b | c` pipelines are allowed." },
      timeoutMs: { type: "number", minimum: 1, maximum: 120000, description: "Optional foreground timeout in milliseconds." },
    } } };
  }) };
  const previous = toolCatalogHash(legacy);
  assert.ok(compatibleCatalogHashes(root).includes(previous), "a documentation-only change cannot strand saved work");
});
