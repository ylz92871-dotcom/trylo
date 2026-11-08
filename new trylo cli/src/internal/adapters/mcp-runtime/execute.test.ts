import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpToolOutcome, McpToolSpec } from "../../ports/mcp-client.js";
import type { ToolBinding } from "../../ports/tools.js";
import { callTimeoutMs, createMcpToolPort, mcpFailureCode } from "./execute.js";
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  bindingForSpec,
  type McpMountedTool,
} from "./mount.js";
import type { McpRuntimeCall, McpRuntimeServer } from "./pool.js";
import { brokerRequestError } from "./broker-errors.js";

/**
 * Execute contracts: routing, the deadline, cancellation and the failure table.
 *
 * Cancellation gets the most attention because it is the one that cannot be
 * checked by looking at the happy path: `ToolPort.cancel` is a *different*
 * call from `execute`, and the only way it can work is if the in-flight call
 * left something behind for it to reach.
 */

function spec(serverId: string, tool: string): McpToolSpec {
  return {
    serverToolName: tool,
    qualifiedName: `mcp__${serverId}__${tool}`,
    serverId,
    description: "does a thing",
    inputSchema: { type: "object" },
    annotations: {},
    annotationsTrust: "untrusted",
    needsApproval: true,
  };
}

type Recorded = {
  readonly calls: Array<{ readonly tool: string; readonly timeoutMs: number | undefined }>;
};

function mounted(
  server: McpRuntimeServer,
  tool: McpToolSpec,
): McpMountedTool {
  const binding = bindingForSpec(tool) as ToolBinding;
  return { binding, server, spec: tool };
}

function stubServer(
  serverId: string,
  tools: ReadonlyArray<McpToolSpec>,
  call: (tool: McpToolSpec, timeoutMs: number | undefined, signal: AbortSignal) => Promise<McpRuntimeCall>,
  recorded: Recorded,
): McpRuntimeServer {
  return {
    serverId,
    tools,
    async call(serverToolName, _args, timeoutMs, signal) {
      const tool = tools.find((item) => item.serverToolName === serverToolName);
      recorded.calls.push({ tool: serverToolName, timeoutMs });
      if (tool === undefined) {
        return { ok: false, code: "unknown_tool", detail: serverToolName };
      }
      return await call(tool, timeoutMs, signal);
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
}

test("a call for a name that never mounted fails closed", async () => {
  const recorded: Recorded = { calls: [] };
  const port = createMcpToolPort([]);
  const outcome = await port.execute(
    { toolCallId: "c1", name: "mcp__ghost__echo", arguments: {} },
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, "error");
  assert.equal(recorded.calls.length, 0);
  assert.match(outcome.outcome === "error" ? outcome.code : "", /^mcp_unknown_tool$/);
});

test("the binding's deadline applies when the model supplies none", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("alpha", "echo");
  const server = stubServer("alpha", [tool], async () => ({
    ok: true,
    outcome: { outcome: "result", value: {}, output: "ok", truncated: false },
  }), recorded);
  const port = createMcpToolPort([mounted(server, tool)]);

  await port.execute({ toolCallId: "c1", name: tool.qualifiedName, arguments: {} }, new AbortController().signal);
  assert.equal(recorded.calls[0]?.timeoutMs, DEFAULT_MCP_CALL_TIMEOUT_MS);
});

test("a usable timeout argument overrides the binding, an unusable one is refused", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("alpha", "echo");
  const server = stubServer("alpha", [tool], async () => ({
    ok: true,
    outcome: { outcome: "result", value: {}, output: "ok", truncated: false },
  }), recorded);
  const port = createMcpToolPort([mounted(server, tool)]);
  const signal = new AbortController().signal;

  await port.execute(
    { toolCallId: "c1", name: tool.qualifiedName, arguments: { timeoutMs: 250 } },
    signal,
  );
  assert.equal(recorded.calls[0]?.timeoutMs, 250);

  const refused = await port.execute(
    { toolCallId: "c2", name: tool.qualifiedName, arguments: { timeoutMs: -1 } },
    signal,
  );

  assert.equal(refused.outcome, "error");
  assert.equal(refused.outcome === "error" ? refused.code : "", "mcp_invalid_arguments");
  assert.equal(recorded.calls.length, 1);

  assert.equal(callTimeoutMs({}, DEFAULT_MCP_CALL_TIMEOUT_MS), DEFAULT_MCP_CALL_TIMEOUT_MS);
  assert.equal(callTimeoutMs({ timeoutMs: 0 }, DEFAULT_MCP_CALL_TIMEOUT_MS), undefined);
  assert.equal(callTimeoutMs({ timeoutMs: "10" }, DEFAULT_MCP_CALL_TIMEOUT_MS), undefined);
  assert.equal(callTimeoutMs({ timeoutMs: Number.NaN }, DEFAULT_MCP_CALL_TIMEOUT_MS), undefined);
});

test("a turn cancel reaches the call that is already running", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("alpha", "slow");
  let sawAbort = false;
  const server = stubServer("alpha", [tool], async (_tool, _timeoutMs, signal) => {
    return await new Promise<McpRuntimeCall>((resolve) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        resolve({ ok: true, outcome: { outcome: "cancelled" } });
      }, { once: true });
    });
  }, recorded);
  const port = createMcpToolPort([mounted(server, tool)]);
  const outer = new AbortController();
  const pending = port.execute(
    { toolCallId: "c1", name: tool.qualifiedName, arguments: {} },
    outer.signal,
  );

  await port.cancel("c1");
  const outcome = await pending;

  assert.equal(sawAbort, true);
  assert.equal(outcome.outcome, "cancelled");
});

test("a turn already cancelled never spends a round trip", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("alpha", "echo");
  const server = stubServer("alpha", [tool], async () => ({
    ok: true,
    outcome: { outcome: "result", value: {}, output: "ok", truncated: false },
  }), recorded);
  const port = createMcpToolPort([mounted(server, tool)]);
  const controller = new AbortController();

  controller.abort();
  const outcome = await port.execute(
    { toolCallId: "c1", name: tool.qualifiedName, arguments: {} },
    controller.signal,
  );

  assert.equal(outcome.outcome, "cancelled");
  assert.equal(recorded.calls.length, 0);
});

test("every MCP failure code maps to this adapter's own vocabulary", () => {
  const table: ReadonlyArray<[string, string]> = [
    ["not_initialized", "mcp_not_initialized"],
    ["unknown_tool", "mcp_unknown_tool"],
    ["invalid_arguments", "mcp_invalid_arguments"],
    ["timeout", "mcp_timeout"],
    ["child_crashed", "mcp_child_crashed"],
    ["framing", "mcp_framing"],
    ["protocol_error", "mcp_protocol_error"],
    ["capability_unsupported", "mcp_capability_unsupported"],
    ["stderr_overflow", "mcp_stderr_overflow"],
  ];

  for (const [from, to] of table) {
    assert.equal(mcpFailureCode(from), to, from);
  }

  // A code from outside the port's closed set passes through instead of being
  // flattened into a code nobody can act on.
  assert.equal(mcpFailureCode("adapter_exception"), "adapter_exception");
});

test("a failed call is an error outcome carrying the mapped code", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("alpha", "echo");
  const server = stubServer("alpha", [tool], async () => ({
    ok: false,
    code: "timeout",
    detail: "the server did not answer before the deadline",
  }), recorded);
  const port = createMcpToolPort([mounted(server, tool)]);
  const outcome = await port.execute(
    { toolCallId: "c1", name: tool.qualifiedName, arguments: {} },
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, "error");
  assert.equal(outcome.outcome === "error" ? outcome.code : "", "mcp_timeout");
  assert.equal(outcome.outcome === "error" ? outcome.message : "", "the server did not answer before the deadline");
});

test("a server that throws becomes an unknown outcome, never a rejected promise", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("alpha", "echo");
  const server = stubServer("alpha", [tool], async () => {
    throw new Error("the transport exploded");
  }, recorded);
  const port = createMcpToolPort([mounted(server, tool)]);
  const outcome = await port.execute(
    { toolCallId: "c1", name: tool.qualifiedName, arguments: {} },
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, "unknown");
  assert.equal(outcome.outcome === "unknown" ? outcome.code : "", "mcp_adapter_exception");
});

test("a confirmed undispatched broker call is a normal tool error without replay", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("office", "officecli");
  const server = stubServer("office", [tool], async () => {
    throw brokerRequestError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED", syscall: "connect" }),
    }));
  }, recorded);
  const outcome = await createMcpToolPort([mounted(server, tool)]).execute(
    { toolCallId: "help", name: tool.qualifiedName, arguments: { command: "help docx equation" } },
    new AbortController().signal,
  );
  assert.equal(outcome.outcome, "error");
  assert.equal(outcome.outcome === "error" ? outcome.code : "", "mcp_broker_unavailable");
  assert.match(outcome.outcome === "error" ? outcome.message : "", /did not execute/u);
  assert.equal(recorded.calls.length, 1);
});

test("a broker response lost after dispatch keeps the unknown effect protection", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("office", "officecli");
  const server = stubServer("office", [tool], async () => {
    throw brokerRequestError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET", syscall: "read" }),
    }));
  }, recorded);
  const outcome = await createMcpToolPort([mounted(server, tool)]).execute(
    { toolCallId: "write", name: tool.qualifiedName, arguments: { command: "create report.docx" } },
    new AbortController().signal,
  );
  assert.equal(outcome.outcome, "unknown");
  assert.equal(outcome.outcome === "unknown" ? outcome.code : "", "mcp_broker_delivery_unknown");
  assert.match(outcome.outcome === "unknown" ? outcome.message : "", /do not repeat/u);
  assert.equal(recorded.calls.length, 1);
});

test("a server cannot self-report an undispatched transport failure with a plain object", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("office", "officecli");
  const server = stubServer("office", [tool], async () => {
    throw { delivery: "not_dispatched", code: "mcp_broker_unavailable", message: "trust me" };
  }, recorded);
  const outcome = await createMcpToolPort([mounted(server, tool)]).execute(
    { toolCallId: "write", name: tool.qualifiedName, arguments: { command: "create report.docx" } },
    new AbortController().signal,
  );
  assert.equal(outcome.outcome, "unknown");
  assert.equal(outcome.outcome === "unknown" ? outcome.code : "", "mcp_adapter_exception");
  assert.equal(recorded.calls.length, 1);
});

test("a successful result is returned in the loop's own outcome shape", async () => {
  const recorded: Recorded = { calls: [] };
  const tool = spec("alpha", "echo");
  const rich: McpToolOutcome = {
    outcome: "result",
    value: { echoed: "hi" },
    output: "hi",
    truncated: true,
  };
  const server = stubServer("alpha", [tool], async () => ({ ok: true, outcome: rich }), recorded);
  const port = createMcpToolPort([mounted(server, tool)]);
  const outcome = await port.execute(
    { toolCallId: "c1", name: tool.qualifiedName, arguments: {} },
    new AbortController().signal,
  );

  assert.deepEqual(outcome, rich);
  assert.deepEqual(
    port.snapshot().map((binding) => binding.name),
    ["mcp__alpha__echo"],
  );
});
