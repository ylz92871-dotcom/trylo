import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createCollaborationCapabilities } from "./collaboration-capabilities.js";
import { loadConfig } from "./config-load.js";
import { resolveSettings } from "./run-settings.js";
import { wirePorts } from "./wiring.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { dispatchToolPort } from "../../subagent/dispatch-tool-port.js";
import type { ProviderPort } from "../../ports/provider.js";
import { decision, type PermissionAction, type PermissionPort } from "../../ports/permission.js";
import type { ToolPort } from "../../ports/tools.js";

function fixture(approved = true, ceiling?: readonly string[]) {
  const base = testScratchPath("collaboration-tool-configuration");
  mkdirSync(base, { recursive: true });
  const scope = mkdtempSync(path.join(base, "case-")), profile = path.join(scope, "profile"), actions: PermissionAction[] = [];
  let description = "binding-v1", denied = false, rawCalls = 0;
  const tools: ToolPort = { snapshot: () => ["read_file", "write_file"].map(name => ({ name, description,
    parameters: { type: "object", properties: {} }, sideEffect: name === "read_file" ? "read_only" : "workspace_write",
    needsApproval: name !== "read_file", timeoutMs: 1000, outputLimits: { maxBytes: 1024, maxLines: 20 } })),

  async execute() {
    rawCalls += 1;
    return { outcome: "result", value: {}, output: "original execution", truncated: false };
  }, cancel: async () => {} };
  const permission: PermissionPort = { isDenied: () => denied,

    async request(action) {
      actions.push(action);
      return { ticketId: `permission:${actions.length}`, toolCallId: action.toolCallId };
    },

    async awaitDecision() { return decision(approved ? "approved" : "denied", "once"); } };
  const provider: ProviderPort = { async *stream() { throw new Error("These local contracts must not call a provider"); } };
  const capabilities = createCollaborationCapabilities({ scope, taskId: "task", homeRoot: profile, boardRoot: path.join(profile, "learning/board"),
    tools, workspaceTools: tools, catalogTools: tools, provider, model: "no-provider-contract", permission,
    sandbox: createWorkspaceSandbox({ workspaceRoot: scope }), grants: createPermissionGrantCache(), experience: { load: async () => "" },
    now: () => "2026-11-03T12:00:00.000Z", ...(ceiling === undefined ? {} : { toolSelectionCeiling: ceiling }) });

  return { scope, profile, tools, permission, capabilities, actions, config: path.join(scope, ".trylo/config.json"),
    changeBinding() { description = "binding-v2"; }, deny() { denied = true; }, calls: () => rawCalls,
    close() { rmSync(scope, { recursive: true, force: true }); } };
}

test("PA configure requires exact original Permission and saves the original settings without hiding the recovery catalog", async () => {
  const blocked = fixture(false);
  try {
    const result = await blocked.capabilities.toolLibrary.configure({ memberId: "personal_agent", scope: blocked.scope }, ["runtime:read_file"]);
    assert.equal(result.ok, false);
    assert.equal(blocked.actions[0]!.name, "tool_library.configure");
    assert.throws(() => readFileSync(blocked.config, "utf8"), /ENOENT/);
  } finally { blocked.close(); }

  const cancelled = fixture();
  try {
    const cancellation = new AbortController();
    cancelled.permission.awaitDecision = async () => {
      cancellation.abort();
      return decision("approved", "once");
    };
    assert.deepEqual(await cancelled.capabilities.executeTool("personal_agent", { operation: "configure", toolIds: ["runtime:read_file"] }, cancellation.signal),
      { ok: false, code: "cancelled", message: "Tool configuration was cancelled" });
    assert.throws(() => readFileSync(cancelled.config, "utf8"), /ENOENT/);
  } finally { cancelled.close(); }

  const h = fixture();
  try {
    mkdirSync(path.dirname(h.config), { recursive: true });
    writeFileSync(h.config, JSON.stringify({ formatVersion: 1, model: "preserved-model" }));
    assert.ok((await h.capabilities.toolLibrary.configure({ memberId: "personal_agent", scope: h.scope }, [])).ok);
    assert.deepEqual(h.actions[0]!.arguments, { scope: h.scope, memberId: "personal_agent", businessToolNames: [] });
    assert.deepEqual(JSON.parse(readFileSync(h.config, "utf8")), { formatVersion: 1, model: "preserved-model", toolSelection: [] });
    assert.deepEqual(h.capabilities.configuredTools.snapshot(), []);
    const catalog = await h.capabilities.toolLibrary.query({ memberId: "personal_agent", scope: h.scope });
    assert.ok(catalog.ok);
    assert.equal(catalog.value.items.length, 2);
    assert.ok(catalog.value.items.every(item => !item.configured && item.configuration === "configurable"));
    assert.ok((await h.capabilities.toolLibrary.configure({ memberId: "personal_agent", scope: h.scope }, ["runtime:read_file"])).ok);
    assert.deepEqual(h.capabilities.configuredTools.snapshot().map(tool => tool.name), ["read_file"]);
  } finally { h.close(); }
});

test("normal run consumes original persisted business selection while explicit CLI tools remain the hard ceiling", async () => {
  const h = fixture(true, ["read_file"]);
  try {
    const rejected = await h.capabilities.toolLibrary.configure({ memberId: "personal_agent", scope: h.scope }, ["runtime:write_file"]);

    assert.equal(rejected.ok, false);
    assert.equal(h.actions.length, 0);
    mkdirSync(path.dirname(h.config), { recursive: true });
    writeFileSync(h.config, JSON.stringify({ formatVersion: 1, toolSelection: [] }));
    const loaded = loadConfig({ cwd: h.scope, profileDir: h.profile, readFile: file => {
      try { return readFileSync(file, "utf8"); } catch { return undefined; }
    } }, {});
    assert.ok(loaded.ok);
    const settings = resolveSettings(loaded.resolved);
    assert.ok(!("exitCode" in settings));
    assert.deepEqual(settings.toolSelection, []);

    for (const explicit of [undefined, ["read_file"]]) {
      const wiring = wirePorts({ providerId: "fixture", model: "fixture", endpoint: "", apiKey: undefined, workspaceRoot: h.scope,
        checkpointRoot: path.join(h.profile, "checkpoints"), permission: h.permission, configuredToolSelection: settings.toolSelection,
        ...(explicit === undefined ? {} : { toolSelection: explicit }) });
      assert.ok(!("code" in wiring));
      try { assert.deepEqual(wiring.ports.tools.snapshot().map(tool => tool.name), explicit ?? []); } finally { await wiring.close(); }
    }
  } finally { h.close(); }
});

test("a library-resolved dispatch checks binding and denial before forwarding through the original child tool boundary", async () => {
  const h = fixture();
  try {
    const selected = await h.capabilities.toolLibrary.resolve({ memberId: "personal_agent", scope: h.scope }, ["runtime:read_file"]);
    assert.ok(selected.ok);
    let boundaryCalls = 0;
    const original: ToolPort = { ...h.tools, async execute(call, signal) {
      boundaryCalls += 1;
      return h.tools.execute(call, signal);
    } };
    const mounted = dispatchToolPort(original, selected.value.tools), signal = new AbortController().signal;
    const call = { toolCallId: "child:read", name: "read_file", arguments: {} };

    assert.equal((await mounted.execute(call, signal)).outcome, "result");
    assert.equal(boundaryCalls, 1);
    assert.equal(h.calls(), 1);
    h.changeBinding();
    assert.equal((await mounted.execute({ ...call, toolCallId: "child:stale" }, signal)).outcome, "error");
    assert.equal(boundaryCalls, 1);
    assert.equal(h.calls(), 1);
    h.deny();
    assert.deepEqual(mounted.snapshot(), []);
  } finally { h.close(); }
});
