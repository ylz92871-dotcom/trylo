import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { brokerRequest } from "../../adapters/mcp-runtime/broker-client.js";
import type { BrokerAddress } from "../../adapters/mcp-runtime/broker-contract.js";
import { createMcpToolPort } from "../../adapters/mcp-runtime/execute.js";
import { bindingForSpec } from "../../adapters/mcp-runtime/mount.js";
import type { McpRuntimeServer } from "../../adapters/mcp-runtime/pool.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createFakePermission, createFakeProvider, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import type { McpToolSpec } from "../../ports/mcp-client.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createTurnRecorder } from "./turn-recorder.js";

test("an undispatched broker failure reaches the agent and keeps the durable conversation resumable", async () => {
  const root = mkdtempSync(join(testScratchPath(), "mcp-continuation-"));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const broker: BrokerAddress = { version: 1, key: "closed-listener", token: "a".repeat(43), port: address.port };
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const file = join(root, "s.ndjson");
  const session = createNdjsonSessionStore({ path: file });
  const spec: McpToolSpec = { serverId: "office", serverToolName: "officecli", qualifiedName: "mcp__office__officecli",
    description: "Inspect and edit Office documents", inputSchema: { type: "object" },
    annotations: {}, annotationsTrust: "untrusted", needsApproval: true };
  const binding = bindingForSpec(spec);
  assert.ok("name" in binding);
  let calls = 0;
  const server: McpRuntimeServer = {
    serverId: "office", tools: [spec],
    async call(tool, args, timeoutMs, signal) {
      calls += 1;
      await brokerRequest(broker, { method: "call", server: "office", tool, arguments: args, timeoutMs }, signal);
      return { ok: false, code: "unexpected_reply", detail: "A closed broker must not reply." };
    },
    async listResources() { return { ok: true, value: { resources: [] } }; },
    async listResourceTemplates() { return { ok: true, value: { templates: [] } }; },
    async readResource() { return { ok: true, value: { contents: [] } }; },
    async close() {},
  };
  const requests: ProviderRequest[] = [];
  const scripted = createFakeProvider([
    [{ type: "tool_call", toolCallId: "help", name: spec.qualifiedName, arguments: { command: "help docx equation" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true }],
    [{ type: "text_start", blockId: "answer" }, { type: "text_delta", blockId: "answer", text: "The tool is disconnected; I can continue with another method." },
      { type: "text_end", blockId: "answer" }, { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const provider: ProviderPort = { async *stream(request, signal) {
    requests.push(request);
    yield* scripted.stream(request, signal);
  } };

  try {
    assert.equal((await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z",
      fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } })).ok, true);
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 });
    assert.ok(recorder);
    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
      progress: recorder.progress, provider, tools: createMcpToolPort([{ binding, server, spec }]) },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "Read the equation help and continue." });
    assert.equal(result.state.terminalReason, "completed");
    assert.equal(calls, 1, "the failed business operation is never replayed by transport");
    assert.equal(requests.length, 2, "the agent is called again after the tool error");
    assert.ok(requests[1]?.messages.some(message => message.role === "tool"
      && message.content.includes("mcp_broker_unavailable") && message.content.includes("did not execute")));
    const recovered = await session.read();
    assert.ok(recovered.ok);
    assert.deepEqual(recovered.session.reconcileRequired, []);
    assert.ok(recovered.session.transcript.some(item => item.kind === "tool_result" && item.toolCallId === "help" && item.outcome === "failed"));
    assert.ok(recovered.session.transcript.some(item => item.kind === "assistant_text" && item.text.includes("continue with another method")));
    await session.release();
    const next = createNdjsonSessionStore({ path: file });
    try {
      assert.equal((await next.attach()).ok, true);
      const resumed = await next.read();
      assert.ok(resumed.ok);
      assert.deepEqual(resumed.session.reconcileRequired, []);
      assert.equal(resumed.session.transcript.length, recovered.session.transcript.length);
    } finally { await next.release(); }
  } finally {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  }
});
