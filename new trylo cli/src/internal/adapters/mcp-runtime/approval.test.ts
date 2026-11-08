import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type LoopPorts } from "../../loop/runner.js";
import {
  emptyUsage,
  type ProviderEvent,
  type ProviderPort,
  type ProviderRequest,
} from "../../ports/provider.js";
import type {
  PermissionAction,
  PermissionDecision,
  PermissionPort,
} from "../../ports/permission.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { McpToolSpec } from "../../ports/mcp-client.js";
import type { ToolBinding } from "../../ports/tools.js";
import { createDenyAllPermission } from "../../surface/cli/permission.js";
import { wirePorts } from "../../surface/cli/wiring.js";
import { createMcpToolPort } from "./execute.js";
import { bindingForSpec, mountedNameSet } from "./mount.js";
import type { McpMountedTool, McpRuntimeServer } from "./index.js";

/**
 * Approval, through the real loop.
 *
 * Everything here is about what a *turn* does with an MCP tool, not what the
 * adapter does with a call: the tool is mounted into a real `LoopPorts`, driven
 * by a provider that keeps asking for the same call, and the assertions are
 * about how often a human was asked. That is the whole safety argument of this
 * package — `needsApproval: true` is worth nothing if the loop can be talked
 * out of it — so it is checked where the talk would happen.
 *
 * The repeating provider exists because the doom-loop guard is about
 * *consecutive identical calls*: a provider that asks once cannot show whether
 * the third ask still reaches a person.
 */

function toolSpec(serverId: string, tool: string, annotations: McpToolSpec["annotations"] = {}): McpToolSpec {
  return {
    serverToolName: tool,
    qualifiedName: `mcp__${serverId}__${tool}`,
    serverId,
    description: "does a thing",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations,
    annotationsTrust: "untrusted",
    needsApproval: true,
  };
}

type CountingServer = {
  readonly server: McpRuntimeServer;
  readonly calls: string[];
};

function countingServer(
  serverId: string,
  tools: ReadonlyArray<McpToolSpec>,
  output = "mcp-ok",
): CountingServer {
  const calls: string[] = [];
  return {
    calls,
    server: {
      serverId,
      tools,
      async call(serverToolName) {
        calls.push(serverToolName);
        return {
          ok: true,
          outcome: { outcome: "result", value: { ok: true }, output, truncated: false },
        };
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
    },
  };
}

type Repeating = {
  readonly port: ProviderPort;
  readonly state: { asked: number };
};

function repeatingProvider(toolName: string, args: JsonObject, times: number): Repeating {
  const state = { asked: 0 };
  const port: ProviderPort = {
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      yield { type: "stream_start", providerId: "fixture", model: request.model, warnings: [] };
      const settled = request.messages.filter((message) => message.role === "tool").length;
      if (settled >= times) {
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
        return;
      }

      state.asked += 1;
      // A fresh id per ask: two asks for the same call are two calls, and the
      // reducer is entitled to say so.
      const toolCallId = `call-${settled + 1}`;

      yield { type: "tool_input_start", toolCallId, name: toolName };
      const raw = JSON.stringify(args);

      for (const chunk of raw.match(/.{1,8}/gs) ?? []) {
        if (signal.aborted) {
          yield { type: "cancel_ack" };
          return;
        }
        yield { type: "tool_input_delta", toolCallId, argumentsText: chunk };
      }

      yield { type: "tool_input_end", toolCallId };
      yield { type: "usage", usage: emptyUsage("snapshot") };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    },
  };

  return { port, state };
}

type Recording = {
  readonly port: PermissionPort;
  readonly requests: PermissionAction[];
};

function recordingPermission(): Recording {
  const requests: PermissionAction[] = [];
  let counter = 0;

  return {
    requests,
    port: {
      async request(action) {
        requests.push(action);
        counter += 1;
        return { ticketId: `ticket-${counter}`, toolCallId: action.toolCallId };
      },
      async awaitDecision(): Promise<PermissionDecision> {
        return { resolution: "approved", scope: "session" };
      },
    },
  };
}

function portsFor(
  mounted: ReadonlyArray<McpMountedTool>,
  provider: ProviderPort,
  permission: PermissionPort,
): LoopPorts {
  const wiring = wirePorts({
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission,
    mcp: { tools: createMcpToolPort(mounted), toolNames: mountedNameSet(mounted) },
  });

  assert.equal("code" in wiring, false);

  if ("code" in wiring) {
    throw new Error("wiring failed");
  }

  return { ...wiring.ports, provider };
}

function mountOf(server: McpRuntimeServer, spec: McpToolSpec): McpMountedTool {
  return { binding: bindingForSpec(spec) as ToolBinding, server, spec };
}

test("an MCP tool is approved by a person before it runs, annotations and all", async () => {
  const spec = toolSpec("alpha", "echo", { readOnlyHint: true, idempotentHint: true });
  const counting = countingServer("alpha", [spec]);
  const provider = repeatingProvider(spec.qualifiedName, { text: "hi" }, 1);
  const permission = recordingPermission();
  const result = await runTurn(
    portsFor([mountOf(counting.server, spec)], provider.port, permission.port),
    { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "go" },
  );

  assert.equal(permission.requests.length, 1);
  assert.equal(permission.requests[0]?.name, "mcp__alpha__echo");
  // A `readOnlyHint: true` from a server Trylo does not control cannot make the
  // action look pre-approved, and the fingerprint still covers the arguments.
  assert.equal(permission.requests[0]?.pattern.startsWith("mcp__alpha__echo#"), true);
  assert.notEqual(permission.requests[0]?.pattern, "mcp__alpha__echo#*");
  assert.deepEqual(counting.calls, ["echo"]);
  assert.equal(result.state.terminalReason, "completed");
});

test("a denied question means the server is never called at all", async () => {
  const spec = toolSpec("alpha", "echo");
  const counting = countingServer("alpha", [spec]);
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = {
    async *stream(request) {
      requests.push(request);
      yield { type: "stream_start", providerId: "fixture", model: request.model, warnings: [] };
      if (requests.length === 1) {
        yield { type: "tool_call", toolCallId: "denied", name: spec.qualifiedName, arguments: { text: "hi" } };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        return;
      }

      const denied = request.messages.filter(message => message.role === "tool" && message.toolCallId === "denied");
      assert.equal(denied.length, 1);
      assert.match(denied[0]!.content, /permission_denied/);
      assert.match(denied[0]!.content, /did not run/);
      yield { type: "text_start", blockId: "denial" };
      yield { type: "text_delta", blockId: "denial", text: "This MCP call was denied and did not run." };
      yield { type: "text_end", blockId: "denial" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const result = await runTurn(
    portsFor([mountOf(counting.server, spec)], provider, createDenyAllPermission()),
    { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "go" },
  );

  assert.deepEqual(counting.calls, []);
  assert.equal(requests.length, 2);
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.state.toolCalls.denied?.status, "denied");
  assert.equal(result.transcript.some(item => item.kind === "tool_result" && item.toolCallId === "denied" && item.outcome === "failed"), true);
  assert.equal(result.transcript.some(item => item.kind === "assistant_text" && item.text === "This MCP call was denied and did not run."), true);
});

test("repeated authorized MCP calls keep the user's standing decision", async () => {
  const spec = toolSpec("alpha", "echo");
  const counting = countingServer("alpha", [spec]);
  const provider = repeatingProvider(spec.qualifiedName, { text: "same" }, 3);
  const permission = recordingPermission();
  const result = await runTurn(
    portsFor([mountOf(counting.server, spec)], provider.port, permission.port),
    { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "go" },
  );

  // Repetition alone is not a revocation of a standing user decision.
  assert.deepEqual(counting.calls, ["echo", "echo", "echo"]);
  assert.equal(permission.requests.length, 1);
  assert.equal(new Set(permission.requests.map((action) => action.pattern)).size, 1);
  assert.equal(result.state.terminalReason, "completed");
});

test("a different argument is a different call, so it asks again", async () => {
  const spec = toolSpec("alpha", "echo");
  const counting = countingServer("alpha", [spec]);
  const permission = recordingPermission();
  const ports = portsFor([mountOf(counting.server, spec)], repeatingProvider(spec.qualifiedName, { text: "a" }, 1).port, permission.port);

  await runTurn(ports, { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "go" });
  const second = await runTurn(
    { ...ports, provider: repeatingProvider(spec.qualifiedName, { text: "b" }, 1).port },
    { sessionId: "s1", turnId: "t2", correlationId: "c2", text: "go again" },
  );

  assert.equal(permission.requests.length, 2);
  assert.notEqual(permission.requests[0]?.pattern, permission.requests[1]?.pattern);
  assert.equal(second.state.terminalReason, "completed");
});

test("a giant payload is capped by the loop's own envelope, never streamed through", async () => {
  const spec = toolSpec("alpha", "huge");
  const counting = countingServer("alpha", [spec], "x".repeat(200_000));
  const permission = recordingPermission();
  const result = await runTurn(
    portsFor([mountOf(counting.server, spec)], repeatingProvider(spec.qualifiedName, {}, 1).port, permission.port),
    { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "go" },
  );
  const item = result.transcript.find((entry) => entry.kind === "tool_result");

  assert.equal(item?.kind, "tool_result");

  if (item?.kind !== "tool_result") {
    return;
  }

  // The MCP adapter hands the text over whole; the bound lives in the loop, and
  // this is the end-to-end proof that it fires. The model is told it was cut.
  assert.equal(item.truncated, true);
  // "contains the marker", not "ends with it": the loop's bound keeps the head
  // *and* the tail of an oversized result, because a command's failure is in its
  // last line (`shell-tool.ts` writes `[stderr]` and the failure advisory there).
  // The marker therefore sits in the middle by design, and `endsWith` would be
  // asserting the head-only truncation this bound deliberately stopped doing.
  assert.equal(item.output.includes("[truncated]"), true);
  assert.equal(item.output.length <= 65_536 + "\n[truncated]".length, true);
});
