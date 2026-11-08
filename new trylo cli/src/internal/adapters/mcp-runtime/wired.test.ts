import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpToolSpec } from "../../ports/mcp-client.js";
import type { ToolBinding, ToolPort } from "../../ports/tools.js";
import { createDenyAllPermission } from "../../surface/cli/permission.js";
import { collectDoctor, type DoctorIo } from "../../surface/cli/doctor.js";
import { catalogHash, wirePorts, type WiringInput } from "../../surface/cli/wiring.js";
import { createMcpToolPort } from "./execute.js";
import { bindingForSpec, composeSandbox, mountedNameSet } from "./mount.js";
import type { McpMountedTool, McpRuntimeServer } from "./index.js";

/**
 * The composition root, from the outside.
 *
 * Two claims are checked here that no unit test can make: that **not** asking
 * for MCP produces today's run byte for byte (WP §4-D8), and that asking for it
 * produces a table the *loop* already knows how to use — same `ToolPort` shape,
 * same hash treatment, same sandbox gate. The catalog hash is the sharpest
 * instrument available for the first claim: `catalogHash()` is what the CLI
 * already folds into a session fingerprint, so equality with it is not a
 * convention, it is the old value.
 */

function baseInput(): WiringInput {
  return {
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
  };
}

function spec(serverId: string, tool: string, description = "does a thing"): McpToolSpec {
  return {
    serverToolName: tool,
    qualifiedName: `mcp__${serverId}__${tool}`,
    serverId,
    description,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: {},
    annotationsTrust: "untrusted",
    needsApproval: true,
  };
}

const IDLE_SERVER: McpRuntimeServer = {
  serverId: "alpha",
  tools: [],
  async call() {
    return { ok: true, outcome: { outcome: "cancelled" } };
  },
  async listResources() {
    return { ok: true, value: { resources: [] } };
  },
  async listResourceTemplates() {
    return { ok: true, value: { templates: [] } };
  },
  async readResource() {
    return { ok: true, value: { contents: [] } };
  },
  async close() {},
};

function mcpTable(tools: ReadonlyArray<McpToolSpec>): {
  readonly tools: ToolPort;
  readonly toolNames: ReadonlySet<string>;
} {
  const mounted: McpMountedTool[] = tools.map((item) => ({
    binding: bindingForSpec(item) as ToolBinding,
    server: { ...IDLE_SERVER, tools },
    spec: item,
  }));
  return { tools: createMcpToolPort(mounted), toolNames: mountedNameSet(mounted) };
}

test("D8: a run that never asked for MCP is today's run, byte for byte", () => {
  const without = wirePorts(baseInput());

  assert.equal("code" in without, false);

  if ("code" in without) {
    return;
  }

  // The hash the CLI folds into a session fingerprint, unchanged.
  assert.equal(without.toolCatalogHash, catalogHash(process.cwd()));
  const names = without.ports.tools.snapshot().map((binding) => binding.name);

  assert.equal(names.includes("read_file"), true);
  assert.equal(names.some((name) => name.startsWith("mcp__")), false);
  // The sandbox still refuses an MCP-shaped name: nothing mounted it, so the
  // workspace rules are the only rules that answered.
  const verdict = without.ports.sandbox?.evaluate({
    toolCallId: "c1",
    name: "mcp__ghost__echo",
    arguments: {},
  });

  assert.equal(verdict?.ok, false);
});

test("D8: an empty MCP table changes nothing a hash or a snapshot can see", () => {
  const without = wirePorts(baseInput());
  const empty = wirePorts({ ...baseInput(), mcp: { tools: createMcpToolPort([]), toolNames: new Set() } });

  assert.equal("code" in empty, false);

  if ("code" in without || "code" in empty) {
    return;
  }

  assert.equal(empty.toolCatalogHash, without.toolCatalogHash);
  assert.deepEqual(empty.ports.tools.snapshot(), without.ports.tools.snapshot());
});

test("D6: a mounted tool joins the table and moves the catalog hash", () => {
  const mounted = wirePorts({
    ...baseInput(),
    mcp: mcpTable([spec("alpha", "echo")]),
  });

  assert.equal("code" in mounted, false);

  if ("code" in mounted) {
    return;
  }

  const names = mounted.ports.tools.snapshot().map((binding) => binding.name);

  assert.equal(names.includes("mcp__alpha__echo"), true);
  assert.notEqual(mounted.toolCatalogHash, catalogHash(process.cwd()));
  const binding = mounted.ports.tools.snapshot().find((item) => item.name === "mcp__alpha__echo");

  assert.ok(binding);
  assert.equal(binding.sideEffect, "external");
  assert.equal(binding.needsApproval, true);
});

test("D4: a mounted tool passes the sandbox, an unmounted MCP name does not", () => {
  const mounted = wirePorts({ ...baseInput(), mcp: mcpTable([spec("alpha", "echo")]) });

  assert.equal("code" in mounted, false);

  if ("code" in mounted) {
    return;
  }

  const sandbox = mounted.ports.sandbox;

  assert.ok(sandbox);
  assert.equal(sandbox.evaluate({ toolCallId: "c1", name: "mcp__alpha__echo", arguments: {} }).ok, true);
  assert.equal(sandbox.evaluate({ toolCallId: "c2", name: "mcp__ghost__echo", arguments: {} }).ok, false);
  assert.equal(sandbox.evaluate({ toolCallId: "c3", name: "write_file", arguments: {} }).ok, false);
});

test("D4: the composite sandbox is the workspace sandbox plus admissions, nothing else", () => {
  const mocked = wirePorts(baseInput());

  assert.equal("code" in mocked, false);

  if ("code" in mocked) {
    return;
  }

  const workspace = mocked.ports.sandbox;

  assert.ok(workspace);
  const composite = composeSandbox(workspace, new Set(["mcp__alpha__echo"]));

  assert.deepEqual(composite.policy, workspace.policy);
  assert.equal(composite.evaluate({ toolCallId: "c", name: "mcp__alpha__echo", arguments: {} }).ok, true);
});

function doctorIo(overrides: Partial<DoctorIo> = {}): DoctorIo {
  return {
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    env: {},
    homeDir: "/home/nobody",
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
    nodeVersion: "v22.0.0",
    now: () => 0,
    ...overrides,
  };
}

test("doctor reports the MCP registry, and starts nothing", () => {
  const empty = collectDoctor(doctorIo(), { toolCatalogHash: "hash", sessionsDir: "/tmp/sessions" });
  const skipped = empty.checks.find((check) => check.id === "mcp.registry");

  assert.deepEqual(skipped, {
    id: "mcp.registry",
    status: "skip",
    detail: "no MCP servers registered",
  });
});

test("doctor names a broken registry as a failure rather than as empty", () => {
  const report = collectDoctor(
    doctorIo({ readFile: (path) => (path.endsWith("mcp-servers.json") ? "{ not json" : undefined) }),
    { toolCatalogHash: "hash", sessionsDir: "/tmp/sessions" },
  );
  const check = report.checks.find((item) => item.id === "mcp.registry");

  assert.equal(check?.status, "fail");
  assert.match(check?.detail ?? "", /user:invalid_document/);
});

test("I1: the method subsystem stays unconstructed unless the switch asked for it", () => {
  const wiring = wirePorts(baseInput());

  assert.equal("code" in wiring, false);

  if ("code" in wiring) {
    return;
  }

  // Absent `learning`, nothing is built at all — so this package cannot have
  // made a learning path reachable by accident.
  assert.equal(wiring.ports.method, undefined);
  assert.equal("checkpoint" in wiring.ports, false);
});
