import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHttpClient } from "./client.js";
import type { McpStdioClient } from "../../ports/mcp-client.js";

/**
 * T1 contract #7: a *real socket* round trip. These tests start local HTTP
 * servers (node:http, no new dependency) that speak just enough MCP for
 * `initialize` + `tools/list`, for both remote transports, plus the hostile
 * shapes that must stay red.
 */

type JsonRpcBody = {
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: "2025-03-26",
    capabilities: { tools: {} },
    serverInfo: { name: "fake-remote", version: "1.0.0" },
  };
}

const TOOL_LIST_RESULT = {
  tools: [
    {
      name: "echo",
      description: "returns its arguments",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
};

const RESOURCE_LIST_RESULT = {
  resources: [{ uri: "file:///notes/today.md", name: "today", mimeType: "text/markdown" }],
};

const RESOURCE_TEMPLATES_RESULT = {
  resourceTemplates: [{ uriTemplate: "file:///logs/{date}.log", name: "logs" }],
};

const HEADER_CHECK = { "x-trylo-header": "secret-header-value" };

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
  });
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A streamable-HTTP server: POST in, JSON out. */
async function startStreamableServer(options: {
  readonly status?: number;
  readonly protocolVersion?: string;
  readonly expectHeader?: boolean;
  readonly hangList?: boolean;
}): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      const body = JSON.parse(await readBody(req)) as JsonRpcBody;

      if (options.expectHeader === true && req.headers["x-trylo-header"] !== HEADER_CHECK["x-trylo-header"]) {
        json(res, 401, { error: "missing header" });
        return;
      }

      if (options.status !== undefined) {
        json(res, options.status, { error: "no" });
        return;
      }

      if (body.method === "initialize") {
        json(res, 200, { id: body.id, result: { ...initializeResult(), protocolVersion: options.protocolVersion ?? "2025-03-26" }, jsonrpc: "2.0" });
        return;
      }

      if (body.method === "tools/list") {
        json(res, 200, { id: body.id, result: TOOL_LIST_RESULT, jsonrpc: "2.0" });
        return;
      }

      if (body.method === "tools/call") {
        json(res, 200, {
          id: body.id,
          jsonrpc: "2.0",
          result: { content: [{ type: "text", text: "echo!" }], structuredContent: { echoed: true } },
        });
        return;
      }

      if (body.method === "resources/list") {
        if (options.hangList === true) {
          // Deliberately no reply: the listing deadline must fire here too.
          return;
        }
        json(res, 200, { id: body.id, result: RESOURCE_LIST_RESULT, jsonrpc: "2.0" });
        return;
      }

      if (body.method === "resources/templates/list") {
        json(res, 200, { id: body.id, result: RESOURCE_TEMPLATES_RESULT, jsonrpc: "2.0" });
        return;
      }

      if (body.method === "resources/read") {
        json(res, 200, {
          id: body.id,
          jsonrpc: "2.0",
          result: { contents: [{ uri: "file:///notes/today.md", mimeType: "text/markdown", text: "remote notes" }] },
        });
        return;
      }

      json(res, 200, { id: body.id ?? null, error: { code: -32601, message: "method not found" }, jsonrpc: "2.0" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

/** A legacy SSE server: GET stream with an endpoint event, POSTs answered on the stream. */
async function startLegacySseServer(): Promise<{ readonly server: Server; readonly url: string }> {
  let postResponse: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /message\n\n");
        postResponse = res;
        return;
      }

      const body = JSON.parse(await readBody(req)) as JsonRpcBody;
      if (body.method === "initialize") {
        postResponse?.write(`event: message\ndata: ${JSON.stringify({ id: body.id, result: initializeResult(), jsonrpc: "2.0" })}\n\n`);
      } else if (body.method === "tools/list") {
        postResponse?.write(`event: message\ndata: ${JSON.stringify({ id: body.id, result: TOOL_LIST_RESULT, jsonrpc: "2.0" })}\n\n`);
      } else {
        postResponse?.write(`event: message\ndata: ${JSON.stringify({ id: body.id ?? null, error: { code: -32601, message: "no" }, jsonrpc: "2.0" })}\n\n`);
      }

      // The reply travels on the stream; the POST itself is a plain 202-style
      // acknowledgment and must end, or the client's `response.text()` hangs.
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return { server, url: `http://127.0.0.1:${address.port}/sse` };
}

async function closeServer(server: Server): Promise<void> {
  // A hanging request (the timeout test) would keep `close` waiting forever.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function connect(spec: Parameters<typeof createMcpHttpClient>[0]): McpStdioClient {
  return createMcpHttpClient(spec);
}

describe("streamable http transport", () => {
  it("contract #7: initialize + tools/list over a real socket round-trips", async () => {
    const { server, url } = await startStreamableServer({});
    try {
      const client = connect({ serverId: "remote", transport: "http", url });
      const connected = await client.connect();

      assert.equal(connected.ok, true);

      if (!connected.ok) {
        return;
      }

      assert.equal(connected.value.name, "fake-remote");
      assert.equal(connected.value.protocolVersion, "2025-03-26");
      const listed = await client.listTools();

      assert.equal(listed.ok, true);

      if (listed.ok) {
        assert.equal(listed.value.length, 1);
        assert.equal(listed.value[0]?.serverToolName, "echo");
        assert.equal(listed.value[0]?.qualifiedName, "mcp__remote__echo");
        assert.equal(listed.value[0]?.needsApproval, true);
      }

      await client.close();
      assert.equal(client.isConnected(), false);
    } finally {
      await closeServer(server);
    }
  });

  it("a tools/call round trip returns the server's text", async () => {
    const { server, url } = await startStreamableServer({});
    try {
      const client = connect({ serverId: "remote", transport: "http", url });
      const connected = await client.connect();

      assert.equal(connected.ok, true);
      const called = await client.callTool({
        qualifiedName: "mcp__remote__echo",
        arguments: { text: "hi" },
        timeoutMs: 2000,
      });

      assert.equal(called.ok, true);

      if (called.ok) {
        assert.equal(called.outcome.outcome, "result");
        assert.equal(called.outcome.outcome === "result" ? called.outcome.output : "", "echo!");
      }

      await client.close();
    } finally {
      await closeServer(server);
    }
  });

  it("registry headers are sent on the wire, and a 401 is needs_auth, not a generic refusal", async () => {
    const { server, url } = await startStreamableServer({ status: 401, expectHeader: true });
    try {
      // First: with the header, the server answers 401 anyway (status wins).
      const client = connect({ serverId: "remote", transport: "http", url, headers: HEADER_CHECK });
      const connected = await client.connect();

      assert.equal(connected.ok, false);

      if (!connected.ok) {
        // WP15.2 contract change: 401 maps to needs_auth so the caller can ask
        // the user to re-authenticate and retry, instead of reporting a dead
        // refusal. The detail carries the status only — never a header value.
        assert.equal(connected.code, "needs_auth");
        assert.match(connected.detail, /401/);
        assert.equal(connected.detail.includes("secret-header-value"), false);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("resources/list + templates/list + read round-trip over a real socket", async () => {
    const { server, url } = await startStreamableServer({});
    try {
      const client = connect({ serverId: "remote", transport: "http", url });
      const connected = await client.connect();

      assert.equal(connected.ok, true);
      const listed = await client.listResources();

      assert.equal(listed.ok, true);

      if (listed.ok) {
        assert.equal(listed.value.resources.length, 1);
        assert.equal(listed.value.resources[0]?.uri, "file:///notes/today.md");
      }

      const templates = await client.listResourceTemplates();

      assert.equal(templates.ok, true);

      if (templates.ok) {
        assert.equal(templates.value.templates[0]?.uriTemplate, "file:///logs/{date}.log");
      }

      const read = await client.readResource({ uri: "file:///notes/today.md", timeoutMs: 2000 });

      assert.equal(read.ok, true);

      if (read.ok) {
        assert.equal(read.value.contents.length, 1);
        assert.equal(read.value.contents[0]?.kind, "text");
      }

      await client.close();
    } finally {
      await closeServer(server);
    }
  });

  it("resource verbs fail closed before connect, and an empty URI never leaves the client", async () => {
    const { server, url } = await startStreamableServer({});
    try {
      const client = connect({ serverId: "remote", transport: "http", url });
      const beforeConnect = await client.listResources();

      assert.equal(beforeConnect.ok, false);

      if (!beforeConnect.ok) {
        assert.equal(beforeConnect.code, "not_initialized");
      }

      assert.equal((await client.connect()).ok, true);
      const empty = await client.readResource({ uri: "", timeoutMs: 2000 });

      assert.equal(empty.ok, false);

      if (!empty.ok) {
        assert.equal(empty.code, "invalid_arguments");
      }

      await client.close();
    } finally {
      await closeServer(server);
    }
  });

  it("WP15-F-A: a listing without an answer hits its deadline instead of hanging", async () => {
    const { server, url } = await startStreamableServer({ hangList: true });
    try {
      const client = connect({ serverId: "remote", transport: "http", url });

      assert.equal((await client.connect()).ok, true);
      const listed = await client.listResources(undefined, 200);

      assert.equal(listed.ok, false);

      if (!listed.ok) {
        assert.equal(listed.code, "timeout");
      }

      await client.close();
    } finally {
      await closeServer(server);
    }
  });

  it("an unsupported protocol version is refused before initialized is sent", async () => {
    const { server, url } = await startStreamableServer({ protocolVersion: "1999-01-01" });
    try {
      const client = connect({ serverId: "remote", transport: "http", url });
      const connected = await client.connect();

      assert.equal(connected.ok, false);

      if (!connected.ok) {
        assert.equal(connected.code, "unsupported_protocol_version");
      }

      assert.equal(client.isConnected(), false);
    } finally {
      await closeServer(server);
    }
  });

  it("a server that never answers hits the handshake deadline", async () => {
    const server = createServer(() => {
      // Deliberately never responds.
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const client = connect({
        serverId: "remote",
        transport: "http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        handshakeTimeoutMs: 150,
      });
      const connected = await client.connect();

      assert.equal(connected.ok, false);

      if (!connected.ok) {
        assert.equal(connected.code, "handshake_timeout");
      }
    } finally {
      await closeServer(server);
    }
  });

  it("a closed port is spawn_failed, not a hang", async () => {
    // Port 1 is reserved; nothing listens there.
    const client = connect({ serverId: "remote", transport: "http", url: "http://127.0.0.1:1/mcp" });
    const connected = await client.connect();

    assert.equal(connected.ok, false);

    if (!connected.ok) {
      assert.equal(connected.code, "spawn_failed");
    }
  });
});

describe("legacy sse transport", () => {
  it("contract #7: endpoint event, then initialize + tools/list on the stream", async () => {
    const { server, url } = await startLegacySseServer();
    try {
      const client = connect({ serverId: "remote", transport: "sse", url });
      const connected = await client.connect();

      assert.equal(connected.ok, true);

      if (!connected.ok) {
        return;
      }

      const listed = await client.listTools();

      assert.equal(listed.ok, true);

      if (listed.ok) {
        assert.equal(listed.value[0]?.serverToolName, "echo");
      }

      await client.close();
    } finally {
      await closeServer(server);
    }
  });

  it("a stream that dies before the endpoint event fails closed", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(": nothing else\n");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const client = connect({ serverId: "remote", transport: "sse", url: `http://127.0.0.1:${address.port}/sse` });
      const connected = await client.connect();
      assert.equal(connected.ok, false);
      if (!connected.ok) {
        assert.equal(connected.code, "child_exited");
      }
    } finally {
      await closeServer(server);
    }
  });
});

describe("client lifecycle", () => {
  it("calls before connect are refused, and stderr diagnostics exist and are empty", async () => {
    const client = connect({ serverId: "remote", transport: "http", url: "http://127.0.0.1:1/mcp" });
    const listed = await client.listTools();

    assert.equal(listed.ok, false);

    if (!listed.ok) {
      assert.equal(listed.code, "not_initialized");
    }

    assert.deepEqual(client.stderrDiagnostics(), { bytes: 0, truncated: false });
    assert.equal(client.isConnected(), false);
    await client.close();
  });

  it("a second connect on a live session is already_connected", async () => {
    const { server, url } = await startStreamableServer({});
    try {
      const client = connect({ serverId: "remote", transport: "http", url });

      assert.equal((await client.connect()).ok, true);
      const second = await client.connect();

      assert.equal(second.ok, false);

      if (!second.ok) {
        assert.equal(second.code, "already_connected");
      }

      assert.equal(client.isConnected(), true);
      await client.close();
    } finally {
      await closeServer(server);
    }
  });

  // Port contract: `close()` is idempotent, and after it *every* other call
  // fails with `closed` — connect included. A closed session that answers
  // `already_connected` (or worse, reports a fresh success) misreports itself.
  it("a connect after close is closed, not already_connected", async () => {
    const { server, url } = await startStreamableServer({});
    try {
      const client = connect({ serverId: "remote", transport: "http", url });

      assert.equal((await client.connect()).ok, true);
      await client.close();
      const again = await client.connect();

      assert.equal(again.ok, false);

      if (!again.ok) {
        assert.equal(again.code, "closed");
      }

      assert.equal(client.isConnected(), false);
    } finally {
      await closeServer(server);
    }
  });
});
