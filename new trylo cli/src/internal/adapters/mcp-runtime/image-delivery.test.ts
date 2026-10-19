import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretRemoteToolResult } from "../mcp-http/interpret-remote.js";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverMcpImages } from "./image-delivery.js";
import { withImageReferences } from "../media/image-reference-provider.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { McpToolOutcome } from "../../ports/mcp-client.js";
import { createMcpToolPort } from "./execute.js";
import { bindingForSpec } from "./mount.js";
import type { McpRuntimeServer } from "./pool.js";
import { interpretToolResult } from "../mcp-stdio/client-interpret.js";
import type { StdioTransport } from "../mcp-stdio/transport.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de000000004944415435af061e0000000049454e44ae426082", "hex");
const imageReply = (): McpToolOutcome => interpretRemoteToolResult({ jsonrpc: "2.0", id: 1, result: {
  content: [{ type: "text", text: "Screenshot" }, { type: "image", mimeType: "image/png", data: PNG.toString("base64") }],
} });

test("MCP screenshots survive reply interpretation instead of becoming text-only success", () => {
  const result = interpretRemoteToolResult({ jsonrpc: "2.0", id: 1, result: {
    content: [{ type: "text", text: "Screenshot" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
  } });
  assert.equal(result.outcome, "result");
  assert.deepEqual(Reflect.get(result, "inlineImages"), [{ mimeType: "image/png", data: "aGVsbG8=" }]);
});

test("stdio preserves the same image blocks as remote MCP replies", () => {
  const transport: StdioTransport = {
    async request() { throw new Error("unexpected request"); }, notify() {}, respond() {},
    onIncoming: () => () => {}, onFailure: () => () => {},
    stderrBytes: () => 0, stderrTruncated: () => false, exited: () => false, async terminate() {},
  };
  const result = interpretToolResult({ jsonrpc: "2.0", id: 1, result: {
    content: [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }],
  } }, transport);
  assert.deepEqual(Reflect.get(result, "inlineImages"), [{ mimeType: "image/png", data: PNG.toString("base64") }]);
});

test("screenshot bytes reach the provider without a shell copy or an additional capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-mcp-image-"));
  try {
    const signal = new AbortController().signal;
    const spec = { serverToolName: "Screenshot", qualifiedName: "mcp__computer__Screenshot", serverId: "computer",
      description: "Capture a screenshot", inputSchema: { type: "object" }, annotations: {}, annotationsTrust: "untrusted", needsApproval: true } as const;
    let calls = 0;
    const server: McpRuntimeServer = {
      serverId: "computer", tools: [spec], async call() { calls++; return { ok: true, outcome: imageReply() }; },
      async listResources() { return { ok: true, value: { resources: [] } }; },
      async listResourceTemplates() { return { ok: true, value: { templates: [] } }; },
      async readResource() { return { ok: true, value: { contents: [] } }; }, async close() {},
    };
    const binding = bindingForSpec(spec); assert.ok("name" in binding);
    const port = createMcpToolPort([{ binding, server, spec }], root);
    const result = await port.execute({ toolCallId: "capture", name: spec.qualifiedName, arguments: {} }, signal);
    assert.equal(calls, 1);
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") return;
    assert.equal(result.images?.length, 1);
    assert.equal(Reflect.has(result, "inlineImages"), false);
    assert.equal(JSON.stringify(result).includes(PNG.toString("base64")), false, "journal-facing result must never carry image bytes");
    const seen: ProviderRequest[] = [];
    const provider: ProviderPort = { async *stream(request) { seen.push(request); yield { type: "text_delta", blockId: "b", text: "image delivered" }; } };
    const request: ProviderRequest = { attemptId: "a", model: "fixture", tools: [], messages: [
      { role: "tool", toolCallId: "capture", content: result.output, imageReferences: result.images },
    ] };
    for await (const _event of withImageReferences(provider, root).stream(request, signal)) { /* Consume delivery. */ }
    assert.equal(seen[0]?.messages[0]?.attachments?.[0]?.dataBase64, PNG.toString("base64"));
    assert.match(result.output, /no shell copy/);
    const reference = result.images![0]!;
    assert.deepEqual(readFileSync(join(root, reference.path)), PNG);
    const repeated = await deliverMcpImages(imageReply(), root, signal);
    assert.deepEqual(repeated.outcome === "result" ? repeated.images : [], result.images);
    writeFileSync(join(root, reference.path), "tampered");
    assert.equal((await deliverMcpImages(imageReply(), root, signal)).outcome, "error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("MCP images cannot follow a redirected workspace cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-mcp-image-"));
  const outside = mkdtempSync(join(tmpdir(), "trylo-mcp-outside-"));
  try {
    symlinkSync(outside, join(root, ".trylo"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await deliverMcpImages(imageReply(), root, new AbortController().signal)).outcome, "error");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("invalid image bytes and unavailable delivery are visible failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-mcp-image-"));
  try {
    for (const inlineImages of [[{ mimeType: "image/png", data: "aGVsbG8=" }], [{ mimeType: "image/jpeg", data: PNG.toString("base64") }]]) {
      const reply = { outcome: "result", value: {}, output: "capture", truncated: false, inlineImages } as const;
      assert.equal((await deliverMcpImages(reply, root, new AbortController().signal)).outcome, "error");
    }
    assert.equal((await deliverMcpImages(imageReply(), undefined, new AbortController().signal)).outcome, "error");
    const controller = new AbortController(); controller.abort();
    assert.equal((await deliverMcpImages(imageReply(), root, controller.signal)).outcome, "cancelled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
