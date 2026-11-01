import assert from "node:assert/strict";
import test from "node:test";
import { createMcpStdioClient } from "./client.js";
import type { StdioTransport } from "./transport.js";
import type { JsonRpcNotification } from "../../mcp/jsonrpc.js";

test("successful initialization emits the exact MCP lifecycle notification before operation", async () => {
  const notifications: JsonRpcNotification[] = [];
  const transport: StdioTransport = { request: async request => ({ jsonrpc: "2.0", id: request.id,
    result: { protocolVersion: "2025-03-26", serverInfo: { name: "strict-contract", version: "1" }, capabilities: { tools: {} } } }),
    notify: message => { notifications.push(message); }, respond: () => undefined, onIncoming: () => () => undefined, onFailure: () => () => undefined,
    stderrBytes: () => 0, stderrTruncated: () => false, exited: () => false, terminate: async () => undefined };
  const client = createMcpStdioClient({ serverId: "strict", command: "unused", args: [], env: {}, cwd: ".", transportFactory: () => transport });
  try { assert.equal((await client.connect()).ok, true); assert.deepEqual(notifications, [{ jsonrpc: "2.0", method: "notifications/initialized" }]); }
  finally { await client.close(); }
});
