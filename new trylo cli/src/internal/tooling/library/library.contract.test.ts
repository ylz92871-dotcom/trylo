import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createToolLibrary, runtimeToolId } from "./index.js";
import { createBoardToolLearning, createRuntimeToolSource, createToolLibraryCommandHandler } from "./host/index.js";
import { createMcpRegistry } from "../../adapters/mcp-registry/store.js";
import { openMcpRuntime } from "../../adapters/mcp-runtime/index.js";
import type { PermissionPort } from "../../ports/permission.js";
import { readToolLearningPipeline } from "../../learning/agent/subsystems/tool/runtime/index.js";
import type { ToolBinding, ToolPort } from "../../ports/tools.js";
import { decodeLibraryResult, isToolLibraryCatalog } from "./wire.js";

const context = { memberId: "personal", scope: "workspace" };
const signal = () => new AbortController().signal;

async function temporary(t: import("node:test").TestContext) {
  const base = testScratchPath("tool-library-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("query/configure/resolve delegates to real workspace tools, without granting or prompting", async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, "input.txt"), "library actual file");
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });
  let names: readonly string[] | undefined = [];
  const library = createToolLibrary({ sources: [createRuntimeToolSource({ tools })], access: async () => ({ ok: true, value: {
    tools, configuredNames: names, allowedNames: ["read_file"], permission: {},
  } }), configure: async (_context, selected) => {
    names = selected;
    return { ok: true, value: undefined };
  } });
  const initial = await library.query(context, { text: "read_file" });
  assert.ok(initial.ok);
  assert.equal(initial.value.items[0]?.configured, false);
  const configured = await library.configure(context, [runtimeToolId("read_file")]);
  assert.ok(configured.ok);
  assert.deepEqual(names, ["read_file"]);
  const selected = await library.resolveReferences(context, configured.value);
  assert.ok(selected.ok);
  assert.deepEqual(selected.value.tools.snapshot().map(binding => binding.name), ["read_file"]);
  const result = await selected.value.tools.execute({ toolCallId: "read", name: "read_file", arguments: { path: "input.txt" } }, signal());

  assert.equal(result.outcome, "result");
  if (result.outcome === "result") assert.match(result.output, /library actual file/);

  const hidden = await selected.value.tools.execute({ toolCallId: "hidden", name: "write_file", arguments: { path: "other.txt", content: "no" } }, signal());

  assert.equal(hidden.outcome, "error");
  const denied = await library.resolve(context, [runtimeToolId("write_file")]);
  assert.ok(denied.ok);
  assert.equal(denied.value.rejected[0]?.code, "outside_task_scope");
  const existing = await library.requestCapability(context, { requestKey: "existing", capability: "read_file", taskId: "task" }, signal());

  assert.ok(existing.ok);
  assert.equal(existing.value.kind, "existing");
});

test("runtime references fail closed after schema drift or a new tool-wide denial", async () => {
  let denied = false, calls = 0;
  let binding: ToolBinding = { name: "custom", description: "custom tool", parameters: { type: "object" }, sideEffect: "external", needsApproval: true, timeoutMs: 100, outputLimits: { maxBytes: 100, maxLines: 10 } };
  const tools: ToolPort = { snapshot: () => [binding], execute: async () => {
    calls++;
    return { outcome: "result", value: {}, output: "called", truncated: false };
  }, cancel: async () => {} };
  const library = createToolLibrary({ sources: [createRuntimeToolSource({ tools })], access: async () => ({ ok: true, value: { tools, configuredNames: [], permission: { isDenied: () => denied } } }) });
  const selected = await library.resolve(context, [runtimeToolId("custom")]);
  assert.ok(selected.ok);
  binding = { ...binding, needsApproval: false };
  assert.equal((await selected.value.tools.execute({ toolCallId: "stale", name: "custom", arguments: {} }, signal())).outcome, "error");
  const stale = await library.resolveReferences(context, selected.value.references);
  assert.equal(stale.ok, false);
  denied = true;
  const next = await library.resolve(context, [runtimeToolId("custom")]);
  assert.ok(next.ok);
  assert.equal(next.value.rejected[0]?.code, "permission_denied");
  assert.equal(calls, 0);
});

test("a registered MCP server resolves to its real child-process executor with original approval semantics", async t => {
  const root = await temporary(t), registry = createMcpRegistry({ userFile: path.join(root, "mcp.json"), projectFile: path.join(root, "project.json") });

  assert.ok((await registry.add({ name: "library", scope: "user", transport: "stdio", command: process.execPath,
    args: [path.resolve("testdata/mcp/fake-server.mjs"), "ok"], env: {}, enabled: true })).ok);
  const runtime = await openMcpRuntime({ registry, cwd: path.resolve(".") });
  t.after(runtime.close);
  const library = createToolLibrary({ sources: [createRuntimeToolSource({ tools: runtime.tools })], access: async () => ({ ok: true, value: { tools: runtime.tools, configuredNames: [], permission: {} } }) });
  const selected = await library.resolve(context, [runtimeToolId("mcp__library__echo")]);
  assert.ok(selected.ok);
  assert.equal(selected.value.rejected.length, 0);
  assert.equal(selected.value.tools.snapshot()[0]?.needsApproval, true);
  const result = await selected.value.tools.execute({ toolCallId: "mcp", name: "mcp__library__echo", arguments: { text: "real MCP round trip" } }, signal());

  assert.equal(result.outcome, "result", JSON.stringify(result));
  if (result.outcome === "result") assert.match(result.output, /real MCP round trip/);
});

test("new capabilities require consent, persist once in the existing Board and isolate member/scope polling", async t => {
  const root = await temporary(t);
  let resolution: "approved" | "denied" = "denied", prompts = 0;
  const permission: PermissionPort = { request: async action => {
    prompts++;
    return { ticketId: "ticket", toolCallId: action.toolCallId };
  }, awaitDecision: async () => ({ resolution, scope: "once" }) };
  const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} };
  const make = () => createToolLibrary({ sources: [createRuntimeToolSource({ tools })], access: async () => ({ ok: true, value: { tools, configuredNames: [], permission } }),
    learning: createBoardToolLearning({ boardRoot: root, permission: () => permission, now: () => Date.parse("2026-11-03T00:00:00Z") }) });
  const library = make(), demand = { requestKey: "one", capability: "new capability", taskId: "task", relatedRefs: ["issue:1", "grant:2"] };

  assert.equal((await library.requestCapability(context, demand, signal())).ok, false);
  const empty = await readToolLearningPipeline(root);
  assert.ok(empty.ok);
  assert.equal(empty.jobs.length, 0);
  resolution = "approved";
  const first = await library.requestCapability(context, demand, signal());
  assert.ok(first.ok);
  assert.equal(first.value.kind, "request");

  if (first.value.kind !== "request") return;

  const repeated = await make().requestCapability(context, demand, signal());
  assert.deepEqual(repeated, first);
  assert.equal(prompts, 2);
  const persisted = await readToolLearningPipeline(root);
  assert.ok(persisted.ok);
  assert.equal(persisted.jobs.length, 1);
  assert.equal(persisted.jobs[0]?.state, "queued");
  assert.ok(first.value.request.relatedRefs?.includes("grant:2"));
  assert.equal((await library.getRequest({ ...context, memberId: "other" }, first.value.request.requestId)).ok, false);
  assert.equal((await library.getRequest({ ...context, scope: "other" }, first.value.request.requestId)).ok, false);
  assert.deepEqual(first.value.request.toolIds, []);
});

test("wire adapter strips runtime executors and rejects malformed commands/replies", async () => {
  const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} };
  const library = createToolLibrary({ sources: [], access: async () => ({ ok: true, value: { tools, configuredNames: [], permission: {} } }) });
  const command = createToolLibraryCommandHandler(library);

  assert.deepEqual(await command(context, { operation: "resolve", toolIds: [] }, signal()), { ok: true, value: { references: [], rejected: [] } });
  const query = await command(context, { operation: "query" }, signal());
  assert.ok(decodeLibraryResult(query, isToolLibraryCatalog).ok);
  assert.equal(decodeLibraryResult({ ok: true, value: { items: [] } }, isToolLibraryCatalog).ok, false);
  assert.deepEqual(await command(context, { operation: "unknown" }, signal()), { ok: false, code: "unknown_operation", message: "unsupported tool-library operation" });
});
