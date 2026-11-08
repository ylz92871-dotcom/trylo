import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { McpStdioClient, McpToolSpec } from "../../ports/mcp-client.js";
import type { McpServerEntry } from "../../ports/mcp-registry.js";
import { testScratchPath } from "../../testing/scratch.js";
import { handleMcpList } from "../../surface/cli/commands-mcp.js";
import type { CliContext } from "../../surface/cli/context.js";
import { mcpRegistryExitCode } from "../../surface/cli/mcp-wiring.js";
import { openMcpRuntime } from "../mcp-runtime/index.js";
import { openProgressiveMcpRuntime } from "../mcp-runtime/progressive.js";
import { MCP_SEARCH } from "../mcp-runtime/discovery-provider.js";
import { encodeDocument } from "./document.js";
import { createMcpRegistry } from "./store.js";
import { withRuntimeRegistry } from "./runtime-overlay.js";

function entry(name = "trylo-browser", command = "synthetic-browser"): McpServerEntry {
  return { name, command, args: [], env: { TOKEN: "PRIVATE_ENV_CANARY" }, transport: "stdio", enabled: true };
}

function fixture(t: { after(fn: () => void): void }, runtimeEntries = [entry()]) {
  const root = mkdtempSync(testScratchPath("mcp-overlay-"));
  const home = path.join(root, "home"), cwd = path.join(root, "workspace");
  mkdirSync(home);
  mkdirSync(path.join(cwd, ".trylo"), { recursive: true });
  const userFile = path.join(home, "mcp-servers.json"), runtimeFile = path.join(root, "runtime.json");
  writeFileSync(userFile, '{"PRIVATE_DETAIL_CANARY":');
  writeFileSync(runtimeFile, encodeDocument(runtimeEntries));
  const base = createMcpRegistry({ userFile, projectFile: path.join(cwd, ".trylo/mcp-servers.json") });
  const runtime = createMcpRegistry({ userFile: runtimeFile, projectFile: runtimeFile, required: true });
  const registry = withRuntimeRegistry(base, runtime, "overlay");
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { root, home, cwd, userFile, runtimeFile, base, runtime, registry };
}

test("healthy runtime entries remain visible with the original typed base failure", async t => {
  const f = fixture(t);
  const failure = await f.base.names();
  assert.equal(failure.ok, false);
  if (failure.ok) throw new Error("expected broken base registry");
  const names = await f.registry.names(), listed = await f.registry.list();
  assert.equal(names.ok, true, JSON.stringify(names));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!names.ok || !listed.ok) throw new Error("expected independent runtime configuration");
  assert.deepEqual(names.value, ["trylo-browser"]);
  assert.deepEqual(listed.value.servers.map(server => server.name), ["trylo-browser"]);
  const expected = [{ source: "base", coverage: "runtime_only", code: failure.code, detail: failure.detail }];
  assert.deepEqual(Reflect.get(names, "diagnostics"), expected);
  assert.deepEqual(Reflect.get(listed, "diagnostics"), expected);
  const resolved = await f.registry.resolve("trylo-browser");
  assert.ok(resolved.ok && resolved.value.entry.command === "synthetic-browser");
  assert.equal((await f.registry.resolve("unknown-user-server")).ok, false);
});

test("empty or invalid runtime configuration cannot turn a broken base into an empty success", async t => {
  const f = fixture(t, []);
  assert.deepEqual(await f.registry.names(), await f.base.names());
  assert.deepEqual(await f.registry.list(), await f.base.list());
  writeFileSync(f.runtimeFile, "broken runtime");
  assert.deepEqual(await f.registry.names(), await f.runtime.names());
  assert.deepEqual(await f.registry.list(), await f.runtime.list());
});

test("runtime precedence and base-only management preserve all file ownership", async t => {
  const f = fixture(t);
  writeFileSync(f.userFile, encodeDocument([entry("trylo-browser", "user-browser")]));
  const runtimeBefore = readFileSync(f.runtimeFile, "utf8");
  const resolved = await f.registry.resolve("trylo-browser");
  assert.ok(resolved.ok && resolved.value.entry.command === "synthetic-browser");
  assert.deepEqual(await f.registry.names(), { ok: true, value: ["trylo-browser"] });
  const added = await f.registry.add({ ...entry("user-added"), scope: "user" });
  assert.equal(added.ok, true);
  const updated = await f.registry.setEnabled({ name: "trylo-browser", scope: "user" }, false);
  assert.ok(updated.ok && !updated.value.enabled);
  assert.equal((await f.registry.remove({ name: "user-added", scope: "user" })).ok, true);
  assert.equal(readFileSync(f.runtimeFile, "utf8"), runtimeBefore);
  writeFileSync(f.userFile, "broken base after management");
  const brokenBefore = readFileSync(f.userFile, "utf8");
  assert.equal((await f.registry.add({ ...entry("refused"), scope: "user" })).ok, false);
  assert.equal(readFileSync(f.userFile, "utf8"), brokenBefore);
});

function syntheticClient(spec: McpToolSpec): McpStdioClient {
  return {
    async connect() { return { ok: true, value: { name: "local-fixture", version: "1", protocolVersion: "2025-03-26", capabilities: {} } }; },
    async listTools() { return { ok: true, value: [spec] }; },
    async callTool() { throw new Error("discovery must not dispatch a business tool"); },
    async listResources() { return { ok: true, value: { resources: [] } }; },
    async listResourceTemplates() { return { ok: true, value: { templates: [] } }; },
    async readResource() { return { ok: true, value: { contents: [] } }; },
    async close() {}, isConnected: () => true, stderrDiagnostics: () => ({ bytes: 0, truncated: false }),
  };
}

test("both runtime owners retain healthy tools and expose a safe partial warning", async t => {
  const f = fixture(t);
  const failure = await f.base.names();
  if (failure.ok) throw new Error("expected broken base registry");
  const spec: McpToolSpec = { serverId: "trylo-browser", serverToolName: "list_pages",
    qualifiedName: "mcp__trylo-browser__list_pages", description: "List browser pages", inputSchema: { type: "object" },
    annotations: {}, annotationsTrust: "untrusted", needsApproval: true };
  const input = { registry: f.registry, cwd: f.cwd, clientFor: () => ({ ok: true as const, client: syntheticClient(spec) }) };
  const eager = await openMcpRuntime(input);
  const progressive = await openProgressiveMcpRuntime(input, { root: f.root, scope: "overlay-fixture", policy: "ask" });
  try {
    assert.ok(eager.toolNames.has(spec.qualifiedName));
    const searched = await progressive.tools.execute({ name: MCP_SEARCH, toolCallId: "search", arguments: { query: "浏览器" } }, new AbortController().signal);
    assert.equal(searched.outcome, "result", JSON.stringify(searched));
    assert.ok(progressive.toolNames.has(spec.qualifiedName));
    const expected = `mcp_registry_partial:base:${failure.code}:runtime_only`;
    assert.ok(eager.warnings.includes(expected), JSON.stringify(eager.warnings));
    assert.ok(progressive.warnings.includes(expected), JSON.stringify(progressive.warnings));
    assert.doesNotMatch(JSON.stringify([eager.warnings, progressive.warnings]), /PRIVATE_|mcp_registry_unavailable/);
    assert.equal(readFileSync(f.userFile, "utf8"), '{"PRIVATE_DETAIL_CANARY":');
  } finally { await eager.close(); await progressive.close(); }
});

test("CLI list marks partial output, retains the failure exit, and redacts diagnostic details", async t => {
  const f = fixture(t);
  const stdout: string[] = [], stderr: string[] = [];
  const ctx: CliContext = { homeDir: f.home, cwd: f.cwd, env: { TRYLO_HOME: f.home, TRYLO_MCP_RUNTIME_REGISTRY: f.runtimeFile },
    nodeVersion: "22.0.0", stdinIsTty: false, readFile: () => undefined, isDirectory: () => true, readDir: () => [],
    writeFile: () => false, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => stdout.push(text), stderr: text => stderr.push(text), now: () => 0, newId: prefix => prefix };
  const failure = await f.base.names();
  if (failure.ok) throw new Error("expected broken base registry");
  const exit = await handleMcpList(ctx, true);
  assert.equal(exit, mcpRegistryExitCode(failure.code));
  const listed: unknown = JSON.parse(stdout.join(""));
  assert.ok(typeof listed === "object" && listed !== null);
  assert.equal(Reflect.get(listed, "partial"), true);
  assert.deepEqual(Reflect.get(listed, "diagnostics"), [{ source: "base", coverage: "runtime_only", code: failure.code }]);
  assert.match(stderr.join(""), new RegExp(`mcp_registry_partial:base:${failure.code}:runtime_only`));
  assert.doesNotMatch([...stdout, ...stderr].join(""), /PRIVATE_|"detail"/);
  assert.match(stdout.join(""), /trylo-browser/);
});
