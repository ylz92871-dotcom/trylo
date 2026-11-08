import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { createDenyAllPermission } from "./permission.js";
import { wirePorts } from "./wiring.js";
import { catalogHash, toolCatalogHash } from "./wiring-catalog.js";
import { executeTurn } from "./host.js";
import type { ToolPort } from "../../ports/tools.js";

test("explicit CLI tool selection is distinct from approval allowances", () => {
  const parsed = parseArgs(["run", "--tools=read_file,todo_write", "do the work"]);
  assert.deepEqual(parsed, { kind: "run", options: {
    message: ["do the work"], readStdin: false, toolSelection: ["read_file", "todo_write"],
  } });
});

function selectedWiring() {
  const input = { providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
    workspaceRoot: process.cwd(), permission: createDenyAllPermission(),
    toolSelection: ["read_file", "todo_write"] };
  const result = wirePorts(input);
  if ("code" in result) throw new Error(result.detail);
  return result;
}

test("selected tools remove the competing checklist and all unrelated wire bindings", async () => {
  const wiring = selectedWiring();
  try {
    assert.deepEqual(wiring.ports.tools.snapshot().map(binding => binding.name).sort(), ["read_file", "todo_write"]);
  } finally { await wiring.close(); }
});

test("a guessed hidden plan tool cannot change working checklist state", async () => {
  const wiring = selectedWiring();
  try {
    const result = await wiring.ports.tools.execute({ toolCallId: "hidden", name: "update_plan",
      arguments: { plan: [{ step: "do work", status: "in_progress" }] } }, new AbortController().signal);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.code, "unknown_tool");
  } finally { await wiring.close(); }
});

test("selection fingerprints describe the selected catalog rather than the full default", async () => {
  const wiring = selectedWiring();
  try {
    const full = wirePorts({ providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
      workspaceRoot: process.cwd(), permission: createDenyAllPermission() });
    if ("code" in full) throw new Error(full.detail);

    try {
      const expected = toolCatalogHash({ ...full.ports.tools,
        snapshot: () => full.ports.tools.snapshot().filter(binding => ["read_file", "todo_write"].includes(binding.name)),
      }, ["read_file", "todo_write"]);
      assert.equal(catalogHash(process.cwd(), ["todo_write", "read_file"]), expected);
      assert.equal(wiring.toolCatalogHash, expected);
      assert.notEqual(expected, full.toolCatalogHash);
    } finally { await full.close(); }
  } finally { await wiring.close(); }
});

test("unknown selected names refuse the real host before any provider response", async () => {
  const output: string[] = [];
  const input = { text: "hello", sessionId: "s", turnId: "t", correlationId: "c", workspaceId: "w",
    workspaceRoot: process.cwd(), checkpointRoot: `${process.cwd()}/../selection-checkpoint`,
    providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
    permission: createDenyAllPermission(), format: "text" as const,
    sink: { stdout: (text: string) => output.push(text), stderr: (text: string) => output.push(text) },
    now: () => 1000, toolSelection: ["missing_tool"] };
  const result = await executeTurn(input);

  assert.equal(result.exitCode, 2);
  assert.deepEqual(output, []);
});

test("the final selection also encloses mounted MCP tools and blocks hidden execution", async () => {
  const executions: string[] = [];
  const mcpTools: ToolPort = {
    snapshot: () => ["mcp__fixture__one", "mcp__fixture__two"].map(name => ({ name, description: name,
      parameters: { type: "object", properties: {} }, sideEffect: "read_only", needsApproval: false,
      timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } })),

    async execute(call) {
      executions.push(call.name);
      return { outcome: "result", value: {}, output: "ok", truncated: false };
    },

    async cancel() { /* Test port has no active resources. */ },
  };
  const wiring = wirePorts({ providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
    workspaceRoot: process.cwd(), permission: createDenyAllPermission(), toolSelection: ["todo_write", "mcp__fixture__one"],
    mcp: { tools: mcpTools, toolNames: new Set(mcpTools.snapshot().map(binding => binding.name)) } });
  if ("code" in wiring) throw new Error(wiring.detail);

  try {
    assert.deepEqual(wiring.ports.tools.snapshot().map(binding => binding.name).sort(), ["mcp__fixture__one", "todo_write"]);
    const outcome = await wiring.ports.tools.execute({ name: "mcp__fixture__two", toolCallId: "hidden", arguments: {} }, new AbortController().signal);
    assert.equal(outcome.outcome, "unknown");
    assert.deepEqual(executions, []);
  } finally { await wiring.close(); }
});

test("empty selections and invalid list syntax are explicit rather than implicit approval", () => {
  const none = parseArgs(["run", "--tools=none", "hello"]);
  assert.deepEqual(none, { kind: "run", options: { message: ["hello"], readStdin: false, toolSelection: [] } });
  for (const raw of ["", "read_file,", "read_file,read_file", "read_*"]) {
    assert.equal(parseArgs(["run", `--tools=${raw}`, "hello"]).kind, "error");
  }
});

test("runtime-only names keep distinct selection identities before mounting", () => {
  assert.notEqual(catalogHash(process.cwd(), ["mcp__fixture__one"]), catalogHash(process.cwd(), ["mcp__fixture__two"]));
  assert.equal(catalogHash(process.cwd(), ["read_file", "todo_write"]), catalogHash(process.cwd(), ["todo_write", "read_file"]));
});
