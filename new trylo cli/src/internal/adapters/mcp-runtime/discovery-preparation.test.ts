import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { discoveryProvider, MCP_INVOKE, MCP_SEARCH } from "./discovery-provider.js";

function request(): ProviderRequest {
  return { attemptId: "prepared-mcp", model: "fixture", messages: [
    { role: "system", content: "Available tools this run: mcp_search_tools, mcp__files__read. Tool availability is not permission; an unapproved call fails the turn." },
    { role: "assistant", content: "", toolCalls: [{ toolCallId: "old", name: "mcp__files__read", arguments: { path: "fixture" } }] },
    { role: "tool", content: "observed", toolCallId: "old" },
  ], tools: [
    { name: MCP_SEARCH, description: "Search", parameters: {} },
    { name: "mcp__files__read", description: "Read", parameters: {} },
  ] };
}

test("MCP's complete presented schema and history are available before the sender", async () => {
  const sent: ProviderRequest[] = [];
  const provider = discoveryProvider({ async *stream(input) { sent.push(input); } }, () => true);
  const base = request();
  const preparation = await provider.prepareRequest?.(base, new AbortController().signal);

  assert.ok(preparation, "the request gate must see MCP's wire presentation");
  const prepared = preparation.apply(base);

  assert.deepEqual(prepared.tools.map(tool => tool.name), [MCP_SEARCH, MCP_INVOKE]);
  assert.equal(prepared.messages[1]!.toolCalls![0]!.name, MCP_INVOKE);

  for await (const _event of provider.stream(prepared, new AbortController().signal)) { /* The sender records its request. */ }

  assert.deepEqual(sent[0], prepared, "stream must not add unmeasured material after preparation");
});

test("MCP composes one inner preparation snapshot and rebases it without repeated reads", async () => {
  let reads = 0;
  const inner: ProviderPort = { async prepareRequest() {
    reads++;
    const context = { role: "system" as const, content: "FROZEN_INNER_CONTEXT" };
    return { apply: base => ({ ...base, messages: [...base.messages, context] }) };
  }, async *stream() {} };
  const provider = discoveryProvider(inner, () => true);
  const base = request();
  const preparation = await provider.prepareRequest?.(base, new AbortController().signal);

  assert.ok(preparation);
  const first = preparation.apply(base);
  const second = preparation.apply({ ...base, messages: [...base.messages, { role: "user", content: "New history after compaction" }] });

  assert.equal(reads, 1);
  assert.equal(first.messages.filter(message => message.content === "FROZEN_INNER_CONTEXT").length, 1);
  assert.equal(second.messages.filter(message => message.content === "FROZEN_INNER_CONTEXT").length, 1);
  assert.ok(second.messages.some(message => message.content === "New history after compaction"));
});

test("a filtered MCP surface does not advertise absent discovery tools", async () => {
  const sent: ProviderRequest[] = [];
  const provider = discoveryProvider({ async *stream(input) { sent.push(input); } }, () => true);
  const base: ProviderRequest = { ...request(), messages: [request().messages[0]!],
    tools: [{ name: "read_file", description: "Read", parameters: {} }] };
  for await (const _event of provider.stream(base, new AbortController().signal)) { /* Direct callers retain adapter compatibility. */ }
  assert.doesNotMatch(sent[0]!.messages[0]!.content, /mcp_search_tools|mcp_call_tool|mcp__files__read/);
});
