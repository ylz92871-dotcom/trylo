import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../adapters/sandbox/index.js";
import { createWorkspaceTools } from "../adapters/tools/index.js";
import { createFixtureProvider } from "../adapters/provider/fixture.js";
import { createSubagentToolPort } from "./subagent-tool.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import { SubagentRuntime } from "./runtime.js";
import type { PermissionPort } from "../ports/permission.js";

for (const kind of ["delegate", "interactive"] as const) test(`${kind} preserves the parent's external read approval`, async () => {
  const base = mkdtempSync(path.join(tmpdir(), "trylo-child-authority-"));
  try {
    const root = path.join(base, "workspace"); mkdirSync(root);
    const external = path.join(base, "external.txt"); writeFileSync(external, "private fixture content");
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root, fileAccess: "host" });
    const tools = createWorkspaceTools({ workspaceRoot: root, sandbox });
    let executed = 0; let asked = 0;
    const runtime = new SubagentRuntime({ tools: { ...tools, execute: async (call, signal) => { executed++; return tools.execute(call, signal); } } });
    const permission: PermissionPort = {
      request: async action => { asked++; return { ticketId: "denied", toolCallId: action.toolCallId }; },
      awaitDecision: async () => ({ resolution: "denied", scope: "once" }),
    };
    const provider = createFixtureProvider({ providerId: "fixture", toolName: "read_file", toolArguments: { path: external }, toolCallId: "read" });
    if (kind === "delegate") {
      const delegated = createSubagentToolPort({ runtime, provider, permission, ...{ sandbox } });
      await delegated.execute({ toolCallId: "delegate", name: "delegate_subagent", arguments: { taskName: "read", prompt: "read", allowedTools: ["read_file"] } }, new AbortController().signal);
    } else {
      const handle = runtime.spawn({ name: "read", lineage: { parentAgentId: "parent", rootAttemptId: "attempt", toolCallId: "spawn" },
        permissions: { allowedTools: ["read_file"] }, worker: createInteractiveChildWorker({ provider, permission, message: "read", ...{ sandbox } }) });
      await handle.wait();
    }
    assert.equal(executed, 0, "a denied external read must never reach the file executor");
    assert.equal(asked, 0, "unapproved external reads are denied without opening a child approval channel");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
