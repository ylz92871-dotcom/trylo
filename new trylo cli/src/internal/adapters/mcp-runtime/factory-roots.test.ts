import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { McpServerEntry } from "../../ports/mcp-registry.js";
import { createMcpStdioClient, type McpClientSpec } from "../mcp-stdio/client.js";
import { createMcpHttpClient, type McpHttpClientSpec } from "../mcp-http/client.js";
import { createClientForEntry } from "./factory.js";

const entry: McpServerEntry = { name: "local", transport: "stdio", command: "node", args: ["server.mjs"], env: {}, enabled: true };

test("local factory gives each execution its own workspace context", () => {
  const opened: McpClientSpec[] = [];
  for (const cwd of [join(process.cwd(), "workspace-a"), join(process.cwd(), "workspace-b")]) {
    assert.equal(createClientForEntry(entry, cwd, { stdio: spec => {
      opened.push(spec);
      return createMcpStdioClient(spec);
    } }).ok, true);
  }
  assert.deepEqual(opened.map(spec => ({ ...spec })), ["workspace-a", "workspace-b"].map(name => ({
    serverId: "local", command: "node", args: ["server.mjs"], env: {},
    cwd: join(process.cwd(), name), workspaceRoot: join(process.cwd(), name),
  })));
});

test("remote factory never sends the local workspace implicitly", () => {
  const opened: McpHttpClientSpec[] = [];
  for (const transport of ["http", "sse"] as const) {
    assert.equal(createClientForEntry({ ...entry, transport, url: "https://example.com/mcp" },
      join(process.cwd(), "private-workspace"), { remote: spec => {
        opened.push(spec);
        return createMcpHttpClient(spec);
      } }).ok, true);
  }
  assert.deepEqual(opened, ["http", "sse"].map(transport => ({ serverId: "local", transport, url: "https://example.com/mcp" })));
});

test("a relative execution cwd keeps its spawn semantics and advertises its absolute workspace", () => {
  let opened: McpClientSpec | undefined;
  assert.equal(createClientForEntry(entry, ".", { stdio: spec => {
    opened = spec;
    return createMcpStdioClient(spec);
  } }).ok, true);
  assert.deepEqual(opened, { serverId: "local", command: "node", args: ["server.mjs"], env: {},
    cwd: ".", workspaceRoot: process.cwd() });
});
