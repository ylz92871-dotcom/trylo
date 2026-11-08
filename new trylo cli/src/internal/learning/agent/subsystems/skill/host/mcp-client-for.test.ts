import assert from "node:assert/strict";
import test from "node:test";
import type { McpCallRequest, McpStdioClient, McpToolOutcome, McpToolSpec } from "../../../../../ports/mcp-client.js";
import type { McpServerEntry } from "../../../../../ports/mcp-registry.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { HermesToolProfile } from "./client.js";
import { hermesProfileClientFor } from "./mcp-client-for.js";
import { MAX_TOOL_OUTPUT_BYTES } from "../../../../../loop/tool-execution.js";
import type { McpClientSpec } from "../../../../../adapters/mcp-stdio/client.js";
import { createClientForEntry } from "../../../../../adapters/mcp-runtime/factory.js";

const profile: HermesToolProfile = { name: "trylo-hermes-skills", command: "python", args: [], env: {},
  allowedTools: ["mcp__trylo-hermes-skills__skills_list", "mcp__trylo-hermes-skills__skill_view"] };
const entry: McpServerEntry = { name: profile.name, command: "python", args: [], env: {}, enabled: true, transport: "stdio" };

function result(body: unknown): McpToolOutcome {
  return { outcome: "result", value: {}, output: JSON.stringify(body), truncated: false };
}

function fixture(outcome: () => McpToolOutcome): McpStdioClient {
  const unused = async (): Promise<never> => { throw new Error("unused fixture operation"); };
  return { connect: unused, listTools: unused, callTool: async () => ({ ok: true, outcome: outcome() }), listResources: unused,
    listResourceTemplates: unused, readResource: unused, close: async () => {}, isConnected: () => true,
    stderrDiagnostics: () => ({ bytes: 0, truncated: false }) };
}

function request(args: JsonObject, tool = "skill_view", server = profile.name): McpCallRequest {
  return { qualifiedName: `mcp__${server}__${tool}`, arguments: args, timeoutMs: 1000 };
}

test("only the default matching native profile receives the bounded 30-second startup window", async () => {
  const seen: McpClientSpec[] = [], native = fixture(() => result({ success: true }));
  const builder = (spec: McpClientSpec) => {
    seen.push(spec);
    return native;
  };
  const open = hermesProfileClientFor(profile, undefined, undefined, builder);

  assert.equal(open(entry, "workspace").ok, true);
  assert.equal(seen[0]?.handshakeTimeoutMs, 30_000);
  assert.equal(seen[0]?.cwd, "workspace");
  assert.deepEqual(seen[0]?.env, entry.env);
  const unrelated = open({ ...entry, name: "another-user-server" }, "other-workspace");

  assert.equal(unrelated.ok, true);
  if (unrelated.ok) await unrelated.client.close();

  assert.equal(seen.length, 1, "unrelated servers retain the original shared factory");
  let injected = 0;
  const custom = hermesProfileClientFor(profile, () => {
    injected++;
    return { ok: true, client: native };
  }, undefined, builder);

  assert.equal(custom(entry, "workspace").ok, true);
  assert.equal(injected, 1);
  assert.equal(seen.length, 1);
  const hostDefault = hermesProfileClientFor(profile, createClientForEntry, undefined, builder);

  assert.equal(hostDefault(entry, "workspace").ok, true);
  assert.equal(seen.length, 2, "the host explicitly supplies the stock default factory");
  assert.equal(seen[1]?.handshakeTimeoutMs, 30_000);
});

test("foreground successful instruction loads record once under the resolved native name", async () => {
  const viewed: string[] = [], native = fixture(() => result({ success: true, name: "resolved-release", content: "instructions" }));
  // A custom profile is authoritative only through the actual bound observer;
  // unrelated historical tools with the same suffix remain unattributed.
  const customProfile = { ...profile, name: "test-hermes", allowedTools: ["mcp__test-hermes__skill_view"] };
  const opened = hermesProfileClientFor(customProfile, () => ({ ok: true, client: native }),
    { viewed: async input => { viewed.push(input.name); }, warn: () => assert.fail("unexpected telemetry warning") })({ ...entry, name: customProfile.name }, "workspace");

  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const reply = await opened.client.callTool(request({ name: "release" }, "skill_view", customProfile.name));

  assert.deepEqual(reply, { ok: true, outcome: result({ success: true, name: "resolved-release", content: "instructions" }) });
  assert.deepEqual(viewed, ["resolved-release"]);
});

test("list, linked files, upstream failures and malformed successes never count as instruction use", async () => {
  const viewed: string[] = [];
  let outcome = result({ success: true, name: "release", content: "instructions" });
  const opened = hermesProfileClientFor(profile, () => ({ ok: true, client: fixture(() => outcome) }),
    { viewed: async input => { viewed.push(input.name); }, warn: () => assert.fail("unexpected telemetry warning") })(entry, "workspace");

  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  await opened.client.callTool(request({}, "skills_list"));
  await opened.client.callTool(request({ name: "release", file_path: "references/check.md" }));
  outcome = result({ success: false, error: "not found" });
  await opened.client.callTool(request({ name: "release" }));
  outcome = result({ success: true, name: "release" });
  await opened.client.callTool(request({ name: "release" }));
  outcome = { outcome: "result", value: {}, output: JSON.stringify({ success: true, name: "release", content: "flagged partial instructions" }), truncated: true };
  await opened.client.callTool(request({ name: "release" }));
  outcome = { outcome: "error", code: "mcp_tool_error", message: "read failed" };
  await opened.client.callTool(request({ name: "release" }));
  assert.deepEqual(viewed, []);
});

test("telemetry failure warns and preserves the successful native read", async () => {
  const warnings: string[] = [], outcome = result({ success: true, name: "release", content: "instructions" });
  const opened = hermesProfileClientFor(profile, () => ({ ok: true, client: fixture(() => outcome) }),
    { viewed: async () => { throw new Error("private dependency error"); }, warn: code => warnings.push(code) })(entry, "workspace");
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(await opened.client.callTool(request({ name: "release" })), { ok: true, outcome });
  assert.deepEqual(warnings, ["hermes_skill_usage_unavailable"]);
});

test("an unflagged astral view that the loop would truncate never records instruction use", async () => {
  const viewed: string[] = [];
  const outcome = result({ success: true, name: "astral-procedure", content: "😀".repeat(17_000) });

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome !== "result") return;

  assert.ok([...outcome.output].length < 20_000);
  assert.ok(Buffer.byteLength(outcome.output, "utf8") > MAX_TOOL_OUTPUT_BYTES);
  const opened = hermesProfileClientFor(profile, () => ({ ok: true, client: fixture(() => outcome) }),
    { viewed: async input => { viewed.push(input.name); }, warn: () => assert.fail("unexpected telemetry warning") })(entry, "workspace");

  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  assert.deepEqual(await opened.client.callTool(request({ name: "astral-procedure" })), { ok: true, outcome });
  assert.deepEqual(viewed, []);
});

test("a mounted private skill profile removes the legacy skill bypass while retaining Memory, session and unrelated servers", async () => {
  const legacyName = "trylo-hermes-capabilities", leafNames = ["skills_list", "skill_view", "skill_propose", "learning_graph_summary",
    "memory_snapshot", "memory_propose", "session_search", "learning_pending_list"];
  const calls: string[] = [];
  const open = hermesProfileClientFor(profile, server => ({ ok: true, client: {
    ...fixture(() => result({ success: true })),
    async listTools() {
      const tools: McpToolSpec[] = leafNames.map(name => ({ serverId: server.name, serverToolName: name,
        qualifiedName: `mcp__${server.name}__${name}`, description: "original native tool", inputSchema: {},
        annotations: {}, annotationsTrust: "untrusted", needsApproval: true }));
      return { ok: true, value: tools };
    },
    async callTool(input) {
      calls.push(input.qualifiedName);
      return { ok: true, outcome: result({ success: true }) };
    },
  } }));
  const current = open(entry, "workspace"), legacy = open({ ...entry, name: legacyName }, "workspace");

  assert.ok(current.ok && legacy.ok);
  const privateList = await current.client.listTools(), legacyList = await legacy.client.listTools();
  assert.ok(privateList.ok && legacyList.ok);
  assert.deepEqual(privateList.value.map(tool => tool.serverToolName), ["skills_list", "skill_view"]);
  assert.deepEqual(legacyList.value.map(tool => tool.serverToolName), ["memory_snapshot", "memory_propose", "session_search", "learning_pending_list"]);

  for (const leaf of leafNames.slice(0, 4)) {
    const blocked = await legacy.client.callTool(request({ name: "release" }, leaf, legacyName));
    assert.equal(blocked.ok, false, `direct invocation of hidden legacy ${leaf} must fail before native code`);
  }

  assert.equal(calls.length, 0);
  assert.equal((await legacy.client.callTool(request({}, "memory_snapshot", legacyName))).ok, true);
  assert.equal((await current.client.callTool(request({ name: "release" }))).ok, true);
  const unrelated = open({ ...entry, name: "unrelated-server" }, "workspace");
  assert.ok(unrelated.ok);
  assert.equal((await unrelated.client.callTool(request({}, "skill_view", "unrelated-server"))).ok, true);
  assert.deepEqual(calls, [`mcp__${legacyName}__memory_snapshot`, "mcp__trylo-hermes-skills__skill_view", "mcp__unrelated-server__skill_view"]);
});
