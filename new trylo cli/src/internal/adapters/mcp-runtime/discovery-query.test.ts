import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { McpStdioClient, McpToolSpec } from "../../ports/mcp-client.js";
import type { ToolOutcome } from "../../ports/tools.js";
import { selectToolPort } from "../../surface/cli/tool-selection.js";
import { record, snapshotRegistry } from "./broker-contract.js";
import { MCP_SEARCH } from "./discovery-provider.js";
import { openProgressiveMcpRuntime } from "./progressive.js";

const definitions = [
  ["trylo-browser", "browser_navigate", "Open a URL in the selected browser page."],
  ["trylo-browser", "browser_take_screenshot", "Capture a screenshot of the selected page."],
  ["trylo-windows", "Screenshot", "Capture the desktop screen."],
  ["trylo-windows", "Click", "Click a desktop element."],
  ["trylo-office", "officecli", "Create, read and modify docx, xlsx and pptx documents."],
  ["audio", "render_audio", "Render an audio clip."],
] as const;
const specs: readonly McpToolSpec[] = definitions.map(([serverId, serverToolName, description]) => ({
  serverId, serverToolName, qualifiedName: `mcp__${serverId}__${serverToolName}`, description,
  inputSchema: { type: "object", properties: {} }, annotations: {}, annotationsTrust: "untrusted", needsApproval: true,
}));

async function fixture(failed = new Set<string>(), connecting?: Promise<void>) {
  const opened: string[] = [], called: string[] = [];
  const entries = [...new Set(specs.map(spec => spec.serverId))].map(name => ({
    name, command: "node", args: [], env: {}, transport: "stdio" as const, enabled: true,
  }));
  const runtime = await openProgressiveMcpRuntime({ registry: snapshotRegistry(entries), cwd: process.cwd(),
    clientFor: entry => {
      const client: McpStdioClient = {
        async connect() {
          opened.push(entry.name);
          await connecting;
          return failed.has(entry.name) ? { ok: false, code: "handshake_timeout", detail: "fixture unavailable" }
            : { ok: true, value: { name: entry.name, version: "1", protocolVersion: "2025-03-26", capabilities: {} } };
        },
        async listTools() { return { ok: true, value: specs.filter(spec => spec.serverId === entry.name) }; },
        async callTool(request) {
          called.push(request.qualifiedName);
          return { ok: true, outcome: { outcome: "result", value: {}, output: "observed", truncated: false } };
        },
        async listResources() { return { ok: true, value: { resources: [] } }; },
        async listResourceTemplates() { return { ok: true, value: { templates: [] } }; },
        async readResource() { return { ok: true, value: { contents: [] } }; },
        async close() {}, isConnected: () => true, stderrDiagnostics: () => ({ bytes: 0, truncated: false }),
      };
      return { ok: true, client };
    } }, { root: "unused-custom-client", scope: "query", policy: "ask" });
  const search = (arguments_: Record<string, string | number>) => runtime.tools.execute({
    name: MCP_SEARCH, toolCallId: "search", arguments: arguments_,
  }, new AbortController().signal);
  return { runtime, opened, called, search };
}

function value(outcome: ToolOutcome) {
  assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
  if (outcome.outcome !== "result") throw new Error("expected search result");
  return outcome.value;
}

function names(outcome: ToolOutcome): string[] {
  const tools = value(outcome).tools;
  assert.ok(Array.isArray(tools), "a query must return actual tool schemas, not just server status");
  return tools.map(tool => {
    assert.ok(record(tool) && typeof tool.name === "string" && record(tool.parameters));
    return tool.name;
  });
}

test("a query without server discovers matching real schemas instead of discarding the query", async () => {
  const f = await fixture();
  try {
    const found = await f.search({ query: "browser screenshot" });
    assert.equal(names(found)[0], "mcp__trylo-browser__browser_take_screenshot");
    assert.deepEqual(f.opened, ["trylo-browser"]);
    assert.deepEqual(f.called, [], "schema discovery must not execute a business tool");
    assert.ok(f.runtime.toolNames.has("mcp__trylo-browser__browser_take_screenshot"));
  } finally { await f.runtime.close(); }
});

for (const [query, server] of [["浏览器", "trylo-browser"], ["电脑控制", "trylo-windows"], ["Office", "trylo-office"]] as const) {
  test(`${query} finds configured ${server} tools through bilingual capability matching`, async () => {
    const f = await fixture();
    try {
      const actual = names(await f.search({ query }));
      assert.ok(actual.length > 0);
      assert.ok(actual.every(name => specs.some(spec => spec.qualifiedName === name && spec.serverId === server)));
      assert.deepEqual(f.opened, [server]);
      assert.deepEqual(f.called, []);
    } finally { await f.runtime.close(); }
  });
}

test("a cross-server screenshot query binds each live schema to its owning server", async () => {
  const f = await fixture();
  try {
    const actual = names(await f.search({ query: "截图" }));
    assert.deepEqual(actual.sort(), ["mcp__trylo-browser__browser_take_screenshot", "mcp__trylo-windows__Screenshot"].sort());
    assert.deepEqual(f.called, []);
    for (const name of actual) {
      const outcome = await f.runtime.tools.execute({ name, toolCallId: name, arguments: {} }, new AbortController().signal);
      assert.equal(outcome.outcome, "result");
    }
    assert.deepEqual(f.called.sort(), actual.sort());
  } finally { await f.runtime.close(); }
});

test("an omitted or blank query keeps the immediate status snapshot without startup", async () => {
  const f = await fixture();
  try {
    for (const args of [{}, { query: "   " }]) {
      const status = value(await f.search(args));
      assert.ok(Array.isArray(status.servers));
      assert.equal(status.servers.length, 4);
      assert.deepEqual(f.opened, []);
    }
  } finally { await f.runtime.close(); }
});

test("no matching schema is distinct from an unavailable configured server", async () => {
  const ready = await fixture(), failed = await fixture(new Set(["trylo-windows"]));
  try {
    const noMatch = value(await ready.search({ query: "quantum banana" }));
    assert.equal(noMatch.status, "no_match");
    assert.deepEqual(noMatch.tools, []);
    assert.ok(Array.isArray(noMatch.servers) && noMatch.servers.every(server => record(server) && server.state === "ready"));
    const unavailable = value(await failed.search({ query: "电脑控制" }));
    assert.equal(unavailable.status, "unavailable");
    assert.ok(Array.isArray(unavailable.servers) && unavailable.servers.some(server => record(server)
      && server.serverId === "trylo-windows" && server.state === "failed" && server.reason === "handshake_timeout"));
    assert.deepEqual(failed.called, []);
  } finally { await ready.runtime.close(); await failed.runtime.close(); }
});

test("invalid serverless query arguments are reported and explicit tool ceilings stay authoritative", async () => {
  const f = await fixture();
  try {
    const searchBinding = f.runtime.tools.snapshot().find(binding => binding.name === MCP_SEARCH);
    assert.ok(searchBinding);
    const properties = searchBinding.parameters.properties;
    assert.ok(record(properties));
    assert.deepEqual(properties.query, { type: "string", maxLength: 500 });
    const invalid = await f.search({ query: 42 });
    assert.ok(invalid.outcome === "error" && invalid.code === "invalid_arguments");
    const limited = selectToolPort(f.runtime.tools, []);
    assert.deepEqual(limited.snapshot(), []);
    const refused = await limited.execute({ name: MCP_SEARCH, toolCallId: "hidden", arguments: { query: "Office" } }, new AbortController().signal);
    assert.ok(refused.outcome === "unknown" && refused.code === "unknown_tool");
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.called, []);
  } finally { await f.runtime.close(); }
});

test("a cancelled query publishes no schema and executes no business tool", async () => {
  let release = () => {};
  const connecting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(new Set(), connecting);
  try {
    const pending = f.search({ query: "浏览器" });
    await setImmediate();
    await f.runtime.tools.cancel("search");
    release();
    assert.equal((await pending).outcome, "cancelled");
    assert.equal(f.runtime.toolNames.has("mcp__trylo-browser__browser_navigate"), false);
    assert.deepEqual(f.called, []);
  } finally { release(); await f.runtime.close(); }
});
