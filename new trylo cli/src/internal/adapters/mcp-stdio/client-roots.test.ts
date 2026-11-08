import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { TRYLO_VERSION } from "../../protocol/version.js";
import { createMcpStdioClient } from "./client.js";
import type { StdioTransport } from "./transport.js";
import type { JsonRpcIncomingRequest, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../../mcp/jsonrpc.js";

function fixture(workspaceRoot?: string) {
  const requests: JsonRpcRequest[] = [];
  const responses: JsonRpcResponse[] = [];
  let incoming: (message: JsonRpcIncomingRequest | JsonRpcNotification) => void = () => undefined;
  let terminated = false;
  const transport: StdioTransport = {
    async request(request) {
      requests.push(request);
      return { jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "roots-fixture", version: "1" } }
        : { tools: [] } };
    },
    notify: () => undefined,
    respond: response => { responses.push(response); },
    onIncoming: listener => { incoming = listener; return () => undefined; },
    onFailure: () => () => undefined,
    stderrBytes: () => 0,
    stderrTruncated: () => false,
    exited: () => terminated,
    terminate: async () => { terminated = true; },
  };
  const spec = { serverId: "fixture", command: "unused", args: [], env: {},
    cwd: join(process.cwd(), "server-install"), transportFactory: () => transport,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }) };
  const client = createMcpStdioClient(spec);
  return { client, requests, responses, ask(method: string, id = "server-1") {
    incoming({ jsonrpc: "2.0", id, method });
  } };
}

test("stdio roots describe the execution workspace, preserve request identity and keep the session usable", async () => {
  const root = join(process.cwd(), "中文 workspace #100%");
  const { client, requests, responses, ask } = fixture(root);
  try {
    assert.equal((await client.connect()).ok, true);
    assert.deepEqual(requests[0]?.params, { protocolVersion: "2025-03-26",
      capabilities: { roots: { listChanged: false } }, clientInfo: { name: "trylo", version: TRYLO_VERSION } });
    ask("roots/list");
    assert.deepEqual(responses, [{ jsonrpc: "2.0", id: "server-1", result: { roots: [{ uri: pathToFileURL(root).href }] } }]);
    assert.equal(client.isConnected(), true);
    assert.equal((await client.listTools()).ok, true);
    assert.equal(responses[0]?.jsonrpc, "2.0");
  } finally { await client.close(); }
});

test("stdio without an explicit workspace keeps roots unsupported and declares no client capabilities", async () => {
  const { client, requests, responses, ask } = fixture();
  try {
    assert.equal((await client.connect()).ok, true);
    assert.deepEqual(requests[0]?.params, { protocolVersion: "2025-03-26",
      capabilities: {}, clientInfo: { name: "trylo", version: TRYLO_VERSION } });
    ask("roots/list");
    assert.equal(responses[0] && "error" in responses[0] ? responses[0].error.code : undefined, -32601);
    assert.equal(client.isConnected(), false);
  } finally { await client.close(); }
});

test("roots support does not enable sampling or elicitation", async () => {
  for (const method of ["sampling/createMessage", "elicitation/create"]) {
    const { client, responses, ask } = fixture(process.cwd());
    try {
      assert.equal((await client.connect()).ok, true);
      ask(method);
      assert.equal(responses[0] && "error" in responses[0] ? responses[0].error.code : undefined, -32601);
      assert.equal(client.isConnected(), false);
    } finally { await client.close(); }
  }
});

test("a real stdio peer can request roots during initialize and complete a subsequent tool call", async () => {
  const workspaceRoot = join(process.cwd(), "中文 workspace #100%");
  const peer = `
    import readline from 'node:readline';
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    let roots;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: 'during-init', method: 'roots/list' });
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26',
          capabilities: { tools: {} }, serverInfo: { name: 'roots-peer', version: '1' } } });
      } else if (message.id === 'during-init') {
        roots = message.result;
      } else if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'context',
          description: 'reports workspace context', inputSchema: { type: 'object' } }] } });
      } else if (message.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(roots) }] } });
      }
    });`;
  const spec = { serverId: "peer", command: process.execPath,
    args: ["--input-type=module", "-e", peer], env: {}, cwd: process.cwd(), workspaceRoot };
  const client = createMcpStdioClient(spec);
  try {
    assert.equal((await client.connect()).ok, true);
    const listed = await client.listTools();
    assert.ok(listed.ok);
    assert.equal(listed.value[0]?.needsApproval, true);
    assert.equal(listed.value[0]?.annotationsTrust, "untrusted");
    const result = await client.callTool({ qualifiedName: "mcp__peer__context", arguments: {} });
    assert.ok(result.ok && result.outcome.outcome === "result", JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.outcome.output), { roots: [{ uri: pathToFileURL(workspaceRoot).href }] });
    assert.equal(client.isConnected(), true);
  } finally { await client.close(); }
});
