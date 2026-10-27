import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createPermissionGrantCache, buildPermissionAction } from "../loop/permission-grants.js";
import { buildSubagentPorts } from "../surface/cli/wiring-subagent.js";
import { createAllowToolsPermission, createDenyAllPermission } from "../surface/cli/permission.js";
import { createSubagentToolBoundary } from "./lineage.js";
import { inheritedPermission } from "./inherited-authority.js";

for (const remembered of [false, true]) {
  test(`a live parent denial wins after child admission (${remembered ? "remembered" : "automatic"} approval)`, async t => {
    let denied = false;
    let dispatched = 0;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const args = { path: "probe.txt", content: "probe" };
    const tools: ToolPort = { snapshot: () => [{ name: "write_file", description: "write", parameters: {},
      sideEffect: "workspace_write", needsApproval: true, timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } }],
      execute: async () => { dispatched += 1; return { outcome: "result", value: {}, output: "written", truncated: false }; },
      cancel: async () => {} };
    const provider: ProviderPort = { async *stream(request) {
      if (!request.messages.some(message => message.role === "tool")) {
        entered(); await released;
        yield { type: "tool_call", name: "write_file", toolCallId: "write", arguments: args };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    } };
    const grants = createPermissionGrantCache();
    if (remembered) grants.record(buildPermissionAction("approved", "write_file", args), "approved", "session");
    const permission = { ...(remembered ? createDenyAllPermission() : createAllowToolsPermission(new Set(["write_file"]))),
      isDenied: (name: string) => denied && name === "write_file" };
    const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, permission, grants,
      model: "test", callerMessages: undefined, roles: [{ name: "worker", description: "worker", allowedTools: ["write_file"] }] });
    t.after(async () => { release(); await built.runtime.cancelAll(); });
    let sequence = 0;
    const call = (name: string, arguments_: JsonObject) => built.tools.execute({ name, arguments: arguments_,
      toolCallId: `parent-${++sequence}` }, new AbortController().signal);
    const spawned = await call("spawn_agent", { message: "write", agent_type: "worker" });
    assert.equal(spawned.outcome, "result");
    if (spawned.outcome !== "result") return;
    await ready;
    denied = true;
    release();
    await call("wait_agent", { targets: [spawned.value["task_id"] ?? ""], timeout_ms: 1000 });
    assert.equal(dispatched, 0);
  });
}

for (const needsApproval of [false, true]) {
  test(`the final boundary checks live parent denial for ${needsApproval ? "approved mutation" : "read-only calls"}`, async () => {
    let denied = false;
    let dispatched = 0;
    const name = needsApproval ? "write_file" : "read_file";
    const args = { path: "probe.txt" };
    const tools: ToolPort = { snapshot: () => [{ name, description: name, parameters: {}, needsApproval,
      sideEffect: needsApproval ? "workspace_write" : "read_only", timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } }],
      execute: async () => { dispatched += 1; return { outcome: "result", value: {}, output: "done", truncated: false }; },
      cancel: async () => {} };
    const grants = createPermissionGrantCache();
    grants.record(buildPermissionAction("approved", name, args), "approved", "session");
    const permissions = { allowedTools: [name], inheritedGrants: grants, inheritedDenial: () => denied };
    const signal = new AbortController().signal;
    const boundary = createSubagentToolBoundary(tools, permissions, { parentAgentId: "parent", rootAttemptId: "root" }, signal);
    assert.equal(boundary.snapshot().length, 1);
    denied = true;
    const result = await boundary.execute({ name, toolCallId: "final", arguments: args }, signal);
    assert.equal(result.outcome, "error");
    assert.equal(dispatched, 0);
    assert.deepEqual(boundary.snapshot(), []);
  });
}

test("the inherited permission view retains the parent's live standing denial", () => {
  let denied = false;
  const parent = { ...createAllowToolsPermission(new Set(["write_file"])), isDenied: () => denied };
  const child = inheritedPermission(parent);
  assert.equal(child.isDenied?.("write_file") ?? false, false);
  denied = true;
  assert.equal(child.isDenied?.("write_file"), true);
});

test("borrowed denial facts keep the original parent receiver", () => {
  const parent = { ...createAllowToolsPermission(new Set(["write_file"])), blocked: new Set<string>(),
    isDenied(name: string): boolean { return this.blocked.has(name); } };
  const child = inheritedPermission(parent);
  parent.blocked.add("write_file");
  assert.equal(child.isDenied?.("write_file"), true);
});
