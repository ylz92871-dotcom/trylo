import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { JsonObject } from "../../protocol/envelope.js";
import { createMcpHttpClient } from "./client.js";

function serverFor(transport: "http" | "sse", askRoots: boolean) {
  const received: JsonObject[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let acceptRoots: (value: JsonObject) => void = () => undefined;
  const rootsResponse = new Promise<JsonObject>(resolve => { acceptRoots = resolve; });
  const encoder = new TextEncoder();
  const fetchImpl: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    if (init?.method === "GET") {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode("event: endpoint\ndata: /message\n\n"));
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    const message = JSON.parse(String(init?.body)) as JsonObject;
    received.push(message);
    if (message["id"] === "root-query") {
      acceptRoots(message);
      return new Response(null, { status: 202 });
    }
    const method = message["method"];
    if (method !== "initialize" && method !== "tools/list" && method !== "resources/list")
      return new Response(null, { status: 202 });
    const reply = { jsonrpc: "2.0", id: message["id"], result: method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "roots-remote", version: "1" } }
      : method === "tools/list" ? { tools: [] } : { resources: [] } };
    const frames = [JSON.stringify(reply)];
    if (askRoots && method === "tools/list")
      frames.unshift(JSON.stringify({ jsonrpc: "2.0", id: "root-query", method: "roots/list" }));
    const data = frames.map(frame => `event: message\ndata: ${frame}\n\n`).join("");
    if (transport === "sse") {
      stream?.enqueue(encoder.encode(data));
      return new Response(null, { status: 202 });
    }
    return new Response(data, { headers: { "content-type": "text/event-stream" } });
  };
  return { url: "https://fixture.invalid/mcp", received, rootsResponse, fetchImpl };
}

for (const transport of ["http", "sse"] as const) {
  test(`${transport} exposes roots only when explicitly supplied and remains usable after roots/list`, async () => {
    const server = serverFor(transport, true);
    const workspaceRoot = join(process.cwd(), "中文 space #100%");
    const spec = { serverId: "remote", transport, url: server.url, workspaceRoot, fetchImpl: server.fetchImpl };
    const client = createMcpHttpClient(spec);
    try {
      const connected = await client.connect();
      assert.equal(connected.ok, true, JSON.stringify(connected));
      assert.deepEqual((server.received[0]?.["params"] as JsonObject)?.["capabilities"], { roots: { listChanged: false } });
      assert.equal((await client.listTools()).ok, true);
      assert.deepEqual(await server.rootsResponse, { jsonrpc: "2.0", id: "root-query", result: { roots: [{ uri: pathToFileURL(workspaceRoot).href }] } });
      assert.equal(client.isConnected(), true);
      assert.equal((await client.listResources()).ok, true);
    } finally { await client.close(); }
  });

  test(`${transport} does not advertise or disclose an implicit local root`, async () => {
    const server = serverFor(transport, false);
    const client = createMcpHttpClient({ serverId: "remote", transport, url: server.url, fetchImpl: server.fetchImpl });
    try {
      const connected = await client.connect();
      assert.equal(connected.ok, true, JSON.stringify(connected));
      assert.deepEqual((server.received[0]?.["params"] as JsonObject)?.["capabilities"], {});
      assert.equal((await client.listTools()).ok, true);
      assert.equal(JSON.stringify(server.received).includes(process.cwd()), false);
    } finally { await client.close(); }
  });

  test(`${transport} without configured roots preserves the unsupported-capability refusal`, async () => {
    const server = serverFor(transport, true);
    const client = createMcpHttpClient({ serverId: "remote", transport, url: server.url, fetchImpl: server.fetchImpl });
    try {
      assert.equal((await client.connect()).ok, true);
      await client.listTools();
      assert.deepEqual(await server.rootsResponse, { jsonrpc: "2.0", id: "root-query",
        error: { code: -32601, message: "unsupported capability: roots/list" } });
      assert.equal(client.isConnected(), false);
    } finally { await client.close(); }
  });
}
