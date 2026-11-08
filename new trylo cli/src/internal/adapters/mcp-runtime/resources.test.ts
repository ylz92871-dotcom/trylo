import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  McpResourceFailure,
  McpResourceListResult,
  McpResourceReadResult,
  McpResourceTemplatesResult,
} from "../../ports/mcp-client.js";
import type { ToolCallRequest, ToolOutcome, ToolPort } from "../../ports/tools.js";
import { DEFAULT_MCP_LIST_TIMEOUT_MS } from "../../ports/mcp-client.js";
import { brokerRequestError } from "./broker-errors.js";
import type { McpRuntimeServer } from "./pool.js";
import {
  combineMcpToolPorts,
  createMcpResourcePort,
  isMcpResourceToolName,
  MCP_LIST_RESOURCES_TOOL,
  MCP_READ_RESOURCE_TOOL,
} from "./resources.js";

/**
 * WP15.2/15.3 resource-tool contracts.
 *
 * Resources enter the task context as three approval-gated tools, following
 * Codex's `mcp_resource.rs` handler split (list / list-templates / read).
 * The behaviours pinned here are the trust and lifecycle ones: every binding
 * is external and approval-gated, names can never collide with server tools,
 * one failing server shrinks the answer instead of failing the call, and an
 * unloaded server stops serving.
 */

type ResourceBehaviour = {
  readonly resources?: McpResourceListResult;
  readonly templates?: McpResourceTemplatesResult;
  readonly read?: McpResourceReadResult;
  readonly failure?: McpResourceFailure["code"];
};

function stubServer(serverId: string, behaviour: ResourceBehaviour = {}): McpRuntimeServer & { close(): Promise<void>; closed(): boolean } {
  let closed = false;
  const refused = (verb: string): McpResourceFailure => ({ ok: false, code: "not_initialized", detail: `${verb}: closed` });

  return {
    serverId,
    tools: [],
    async call() {
      return { ok: false, code: "not_initialized", detail: "no tools" };
    },
    async listResources() {
      if (closed) {
        return refused("listResources");
      }

      if (behaviour.failure !== undefined) {
        return { ok: false, code: behaviour.failure, detail: "refused on purpose" };
      }

      return { ok: true, value: behaviour.resources ?? { resources: [] } };
    },
    async listResourceTemplates() {
      if (closed) {
        return refused("listResourceTemplates");
      }

      if (behaviour.failure !== undefined) {
        return { ok: false, code: behaviour.failure, detail: "refused on purpose" };
      }

      return { ok: true, value: behaviour.templates ?? { templates: [] } };
    },
    async readResource(uri) {
      if (closed) {
        return refused("readResource");
      }

      if (behaviour.failure !== undefined) {
        return { ok: false, code: behaviour.failure, detail: "refused on purpose" };
      }

      const value: McpResourceReadResult = behaviour.read ?? {
        contents: [{ kind: "text", uri, text: `content of ${uri}` }],
      };

      return { ok: true, value };
    },
    async close() {
      closed = true;
    },
    closed: () => closed,
  };
}

function call(name: string, args: ToolCallRequest["arguments"]): ToolCallRequest {
  return { toolCallId: `call-${name}`, name, arguments: args };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

for (const name of [MCP_LIST_RESOURCES_TOOL, "mcp_list_resource_templates", MCP_READ_RESOURCE_TOOL]) {
  for (const [code, syscall, expected, expectedCode] of [
    ["ECONNREFUSED", "connect", "error", "mcp_broker_unavailable"],
    ["ECONNRESET", "read", "unknown", "mcp_broker_delivery_unknown"],
  ] as const) {
    test(`${name} preserves trusted broker ${expected} delivery classification`, async () => {
      const error = brokerRequestError(new TypeError("fetch failed", {
        cause: Object.assign(new Error("native transport error"), { code, syscall }),
      }));
      const server: McpRuntimeServer = { ...stubServer("alpha"),
        async listResources() { throw error; },
        async listResourceTemplates() { throw error; },
        async readResource() { throw error; },
      };
      const outcome = await createMcpResourcePort([server]).execute(call(name,
        name === MCP_READ_RESOURCE_TOOL ? { server: "alpha", uri: "test://resource" } : { server: "alpha" }), liveSignal());
      assert.equal(outcome.outcome, expected);
      assert.ok("code" in outcome);
      assert.equal(outcome.code, expectedCode);
    });
  }
}

test("with no servers there are no resource tools; with servers there are exactly three", () => {
  assert.deepEqual(createMcpResourcePort([]).snapshot(), []);
  const port = createMcpResourcePort([stubServer("alpha")]);
  const names = port.snapshot().map((binding) => binding.name).sort();

  assert.deepEqual(names, ["mcp_list_resource_templates", "mcp_list_resources", "mcp_read_resource"]);

  for (const binding of port.snapshot()) {
    assert.equal(binding.sideEffect, "external");
    assert.equal(binding.needsApproval, true);
  }
});

test("resource tool names can never spell a server tool name", () => {
  assert.equal(isMcpResourceToolName(MCP_LIST_RESOURCES_TOOL), true);
  assert.equal(isMcpResourceToolName(MCP_READ_RESOURCE_TOOL), true);
  assert.equal(isMcpResourceToolName("mcp__alpha__echo"), false);
  assert.equal(isMcpResourceToolName("mcp_list_resources_extra"), false);
});

test("listing fans out across servers and tags each entry with its server", async () => {
  const port = createMcpResourcePort([
    stubServer("alpha", { resources: { resources: [{ uri: "file:///a", name: "a", annotations: {}, annotationsTrust: "untrusted" }] } }),
    stubServer("beta", { resources: { resources: [{ uri: "file:///b", name: "b", annotations: {}, annotationsTrust: "untrusted" }] } }),
  ]);
  const outcome = await port.execute(call(MCP_LIST_RESOURCES_TOOL, {}), liveSignal());

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome !== "result") {
    return;
  }

  const entries = outcome.value["entries"];

  assert.ok(Array.isArray(entries) && entries.length === 2);
  assert.ok(outcome.output.includes("2 resources listed"));
});

test("a cursor without a server is refused, and an unknown server is not guessed", async () => {
  const port = createMcpResourcePort([stubServer("alpha")]);
  const cursorOnly = await port.execute(call(MCP_LIST_RESOURCES_TOOL, { cursor: "page-2" }), liveSignal());

  assert.equal(cursorOnly.outcome, "error");

  if (cursorOnly.outcome === "error") {
    assert.equal(cursorOnly.code, "mcp_invalid_arguments");
  }

  const ghost = await port.execute(call(MCP_LIST_RESOURCES_TOOL, { server: "ghost" }), liveSignal());

  assert.equal(ghost.outcome, "error");

  if (ghost.outcome === "error") {
    assert.equal(ghost.code, "mcp_unknown_server");
  }
});

test("one failing server shrinks the answer; all failing fails the call", async () => {
  const partial = createMcpResourcePort([
    stubServer("alpha", { resources: { resources: [{ uri: "file:///a", name: "a", annotations: {}, annotationsTrust: "untrusted" }] } }),
    stubServer("broken", { failure: "protocol_error" }),
  ]);
  const shrunk = await partial.execute(call(MCP_LIST_RESOURCES_TOOL, {}), liveSignal());

  assert.equal(shrunk.outcome, "result");

  if (shrunk.outcome === "result") {
    const failed = shrunk.value["failed"];
    assert.ok(Array.isArray(failed) && failed.length === 1);
  }

  const allBroken = createMcpResourcePort([stubServer("broken", { failure: "protocol_error" })]);
  const failedCall = await allBroken.execute(call(MCP_LIST_RESOURCES_TOOL, {}), liveSignal());

  assert.equal(failedCall.outcome, "error");

  if (failedCall.outcome === "error") {
    assert.equal(failedCall.code, "mcp_protocol_error");
  }
});

test("a 401 at the server becomes mcp_needs_auth, never a silent empty answer", async () => {
  const port = createMcpResourcePort([stubServer("guarded", { failure: "needs_auth" })]);
  const outcome = await port.execute(
    call(MCP_READ_RESOURCE_TOOL, { server: "guarded", uri: "file:///secret.md" }),
    liveSignal(),
  );

  assert.equal(outcome.outcome, "error");

  if (outcome.outcome === "error") {
    assert.equal(outcome.code, "mcp_needs_auth");
  }
});

test("reading returns the server's text, and refuses an empty server or URI", async () => {
  const port = createMcpResourcePort([stubServer("alpha")]);
  const outcome = await port.execute(
    call(MCP_READ_RESOURCE_TOOL, { server: "alpha", uri: "file:///notes/today.md" }),
    liveSignal(),
  );

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome === "result") {
    assert.ok(outcome.output.includes("content of file:///notes/today.md"));
    assert.equal(outcome.truncated, false);
  }

  const empty = await port.execute(call(MCP_READ_RESOURCE_TOOL, { server: "alpha", uri: "" }), liveSignal());

  assert.equal(empty.outcome, "error");

  if (empty.outcome === "error") {
    assert.equal(empty.code, "mcp_invalid_arguments");
  }
});

test("binary content is reported by size, never decoded into the envelope", async () => {
  const port = createMcpResourcePort([
    stubServer("alpha", {
      read: { contents: [{ kind: "binary", uri: "binary:///logo.png", mimeType: "image/png", byteLength: 6 }] },
    }),
  ]);
  const outcome = await port.execute(
    call(MCP_READ_RESOURCE_TOOL, { server: "alpha", uri: "binary:///logo.png" }),
    liveSignal(),
  );

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome === "result") {
    assert.ok(outcome.output.includes("[binary content omitted: image/png, about 6 bytes]"));
  }
});

test("an unloaded server stops serving: reads fail closed after close", async () => {
  const server = stubServer("alpha");
  const port = createMcpResourcePort([server]);
  const before = await port.execute(
    call(MCP_READ_RESOURCE_TOOL, { server: "alpha", uri: "file:///a" }),
    liveSignal(),
  );

  assert.equal(before.outcome, "result");
  await server.close();
  const after = await port.execute(
    call(MCP_READ_RESOURCE_TOOL, { server: "alpha", uri: "file:///a" }),
    liveSignal(),
  );

  assert.equal(after.outcome, "error");

  if (after.outcome === "error") {
    assert.equal(after.code, "mcp_not_initialized");
  }
});

test("a cancelled call is cancelled, not a failure", async () => {
  const port = createMcpResourcePort([stubServer("alpha")]);
  const controller = new AbortController();

  controller.abort();
  const outcome = await port.execute(
    call(MCP_READ_RESOURCE_TOOL, { server: "alpha", uri: "file:///a" }),
    controller.signal,
  );

  assert.deepEqual(outcome, { outcome: "cancelled" });
});

test("WP15-F-A: listings carry a finite deadline instead of an open-ended wait", async () => {
  const seen: Array<{ readonly verb: string; readonly timeoutMs: number | undefined }> = [];
  const server: McpRuntimeServer = {
    serverId: "alpha",
    tools: [],
    async call() {
      return { ok: false, code: "not_initialized", detail: "no tools" };
    },
    async listResources(_cursor, timeoutMs) {
      seen.push({ verb: "resources/list", timeoutMs });
      return { ok: true, value: { resources: [] } };
    },
    async listResourceTemplates(_cursor, timeoutMs) {
      seen.push({ verb: "resources/templates/list", timeoutMs });
      return { ok: true, value: { templates: [] } };
    },
    async readResource() {
      return { ok: true, value: { contents: [] } };
    },
    async close() {},
  };
  const port = createMcpResourcePort([server]);

  await port.execute(call(MCP_LIST_RESOURCES_TOOL, {}), liveSignal());
  assert.deepEqual(seen, [{ verb: "resources/list", timeoutMs: DEFAULT_MCP_LIST_TIMEOUT_MS }]);
});

function stubToolPort(names: ReadonlyArray<string>, calls: string[]): ToolPort {
  return {
    snapshot: () =>
      names.map((name) => ({
        name,
        description: "stub",
        sideEffect: "external" as const,
        parameters: { type: "object" },
        needsApproval: true as const,
        timeoutMs: 1000,
        outputLimits: { maxBytes: 1024, maxLines: 50 },
      })),
    execute: async (request) => {
      calls.push(request.name);
      const outcome: ToolOutcome = { outcome: "error", code: "mcp_unknown_tool", message: request.name };
      return outcome;
    },
    cancel: async () => {},
  };
}

test("combineMcpToolPorts routes resource names to resources and everything else to tools", async () => {
  const toolCalls: string[] = [];
  const tools = stubToolPort(["mcp__alpha__echo"], toolCalls);
  const resources = createMcpResourcePort([stubServer("alpha")]);
  const combined = combineMcpToolPorts(tools, resources);
  const names = combined.snapshot().map((binding) => binding.name);

  assert.ok(names.includes("mcp__alpha__echo"));
  assert.ok(names.includes(MCP_LIST_RESOURCES_TOOL));
  await combined.execute(call(MCP_LIST_RESOURCES_TOOL, {}), liveSignal());
  assert.deepEqual(toolCalls, []);
  await combined.execute(call("mcp__alpha__echo", {}), liveSignal());
  assert.deepEqual(toolCalls, ["mcp__alpha__echo"]);
});
