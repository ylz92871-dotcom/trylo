import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpStdioClient } from "./client.js";
import type { JsonRpcNotification, JsonRpcResponse } from "../../mcp/jsonrpc.js";
import type { StdioTransport } from "./transport.js";

function startupFixture(delayMs: number | null, handshakeTimeoutMs?: number) {
  const notifications: JsonRpcNotification[] = [];
  let terminated = false;
  const transport: StdioTransport = {
    request: (request, signal) => new Promise<JsonRpcResponse>(resolve => {
      let settled = false;
      const finish = (response: JsonRpcResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      };
      const onAbort = () => finish({ jsonrpc: "2.0", id: request.id,
        error: { code: -32000, message: "aborted: request was cancelled" } });
      const timer = delayMs === null ? undefined : setTimeout(() => finish({
        jsonrpc: "2.0", id: request.id,
        result: { protocolVersion: "2025-03-26", serverInfo: { name: "cold-server", version: "1" }, capabilities: {} },
      }), delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
    notify: message => { notifications.push(message); },
    respond: () => undefined,
    onIncoming: () => () => undefined,
    onFailure: () => () => undefined,
    stderrBytes: () => 0,
    stderrTruncated: () => false,
    exited: () => terminated,
    terminate: async () => { terminated = true; },
  };
  const client = createMcpStdioClient({
    serverId: "cold", command: "unused", args: [], env: {}, cwd: ".",
    transportFactory: () => transport,
    ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
  });
  return { client, notifications, terminated: () => terminated };
}

test("the default handshake accepts a healthy 20-second bundled cold start", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = startupFixture(20_000);
  try {
    const connecting = f.client.connect();
    t.mock.timers.tick(20_000);
    assert.equal((await connecting).ok, true);
    assert.deepEqual(f.notifications, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    assert.equal(f.terminated(), false);
  } finally {
    await f.client.close();
  }
});

test("an explicit shorter handshake deadline still refuses and closes a slow server", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = startupFixture(20_000, 5_000);
  try {
    const connecting = f.client.connect();
    t.mock.timers.tick(5_000);
    const result = await connecting;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "handshake_rejected");
    assert.equal(f.terminated(), true);
    t.mock.timers.tick(20_000);
    assert.deepEqual(f.notifications, []);
  } finally {
    await f.client.close();
  }
});

test("the default discovery deadline still closes a server that never initializes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = startupFixture(null);
  try {
    const connecting = f.client.connect();
    t.mock.timers.tick(30_000);
    const result = await connecting;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "handshake_rejected");
    assert.equal(f.terminated(), true);
    assert.deepEqual(f.notifications, []);
  } finally {
    await f.client.close();
  }
});
