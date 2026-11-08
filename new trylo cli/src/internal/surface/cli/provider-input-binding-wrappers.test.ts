import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import { createFakePermission, createFakeTools } from "../../loop/fakes.js";
import { withImageReferences } from "../../adapters/media/image-reference-provider.js";
import { discoveryProvider, MCP_INVOKE, MCP_SEARCH } from "../../adapters/mcp-runtime/discovery-provider.js";
import { createGovernedChildProvider } from "../../subagent/child-provider.js";
import { createChildProviderSession } from "../../subagent/child-provider-session.js";
import { createInteractiveChildWorker } from "../../subagent/interactive-worker.js";
import type { SubagentContext } from "../../subagent/types.js";
import { createPersonalAgentProvider } from "./collaboration-parent-context.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

const A = "a".repeat(64), B = "b".repeat(64), signal = new AbortController().signal;
const request = (): ProviderRequest => ({ model: "local-binding", attemptId: "attempt:binding", continuationScope: "scope:first",
  messages: [{ role: "user", content: "Complete this local check." }], tools: [] });

function transport(digest = A) {
  const bindings: ProviderRequest[] = [], sends: ProviderRequest[] = [];
  const provider: ProviderPort = {
    inputBindingDigest(value) {
      bindings.push(value);
      return digest;
    },

    async *stream(value) { sends.push(value);
      yield { type: "usage", usage: { ...emptyUsage(), mode: "snapshot", inputTokens: 100, outputTokens: 1, totalTokens: 101 },
        inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens: 100 } };
      yield { type: "text_delta", blockId: "answer", text: "Local completion." };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };

  return { provider, bindings, sends };
}

function personal(provider: ProviderPort, inspected = () => {}) {
  return createPersonalAgentProvider({ provider, scope: "workspace:binding", turnId: "turn:binding", now: () => "2026-11-08T00:00:00Z",
    warn: reason => { throw new Error(reason); },
    experience: { async prepareExperience() { return { ok: true, text: "", versionIds: [], selectionId: "local:empty" }; },
      async recordLoad() { return { ok: true }; }, async recordDispatch() { return { ok: true }; } },

    inspect: async () => {
      inspected();
      return { ok: true, state: { issues: [] }, resources: {} };
    }, recentFacts: () => [] });
}

const context = (): SubagentContext => ({ subagentId: "child:binding", name: "binding-check",
  lineage: { parentAgentId: "parent", rootAttemptId: "attempt:parent" }, signal,
  tools: createFakeTools([], []), reportProgress: () => {}, recordUsage: () => {} });

test("image-reference wrapper retains a pure binding without reading images or sending", () => {
  const raw = transport(), wrapped = withImageReferences(raw.provider, "unused-no-image-root"), input = request();
  assert.equal(wrapped.inputBindingDigest?.(input), A);
  assert.deepEqual(raw.bindings, [input]);
  assert.equal(raw.sends.length, 0);
});

test("personal-agent binding does not prepare, inspect or admit guidance", () => {
  const raw = transport();
  let inspected = 0;
  const wrapped = personal(raw.provider, () => { inspected++; }), input = request();
  assert.equal(wrapped.inputBindingDigest?.(input), A);
  assert.equal(inspected, 0);
  assert.deepEqual(raw.bindings, [input]);
  assert.equal(raw.sends.length, 0);
});

test("MCP binding uses the same pure presentation as its actual stream", async () => {
  const raw = transport(), wrapped = discoveryProvider(raw.provider, () => true), input: ProviderRequest = { ...request(),
    tools: [{ name: MCP_SEARCH, description: "Search", parameters: {} }, { name: "mcp__fixture__read", description: "External", parameters: {} }],
    messages: [{ role: "assistant", content: "", toolCalls: [{ toolCallId: "external:1", name: "mcp__fixture__read", arguments: { value: "public" } }] },
      { role: "tool", content: "Observed public result", toolCallId: "external:1" }] };

  assert.equal(wrapped.inputBindingDigest?.(input), A);
  assert.equal(raw.sends.length, 0);

  for await (const _event of wrapped.stream(input, signal)) { /* local fixture only */ }

  assert.deepEqual(raw.bindings[0], raw.sends[0]);
  assert.equal(raw.bindings[0]?.messages[0]?.toolCalls?.[0]?.name, MCP_INVOKE);
  assert.deepEqual(raw.bindings[0]?.tools.map(tool => tool.name), [MCP_SEARCH, MCP_INVOKE]);
});

test("team-parent dispatch wrapper preserves the selected actual parent binding", async t => {
  const parent = transport(A), child = transport(B), tools = createFakeTools([], []);
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, parentProvider: parent.provider, childProvider: child.provider,
    permission: createFakePermission("approved"), model: "local-binding", callerMessages: undefined });
  t.after(async () => { await built.runtime.cancelAll(); });
  const input = request();
  assert.equal(built.provider.inputBindingDigest?.(input), A);
  assert.deepEqual(parent.bindings, [input]);
  assert.equal(child.bindings.length, 0);
  assert.equal(parent.sends.length, 0);
});

test("governed child binding does not spend or consult a remaining-token gate", () => {
  const raw = transport(), ctx: SubagentContext = { ...context(),
    remainingTokens: () => { throw new Error("Binding cannot reserve or inspect governance"); },
    recordUsage: () => { throw new Error("Binding cannot charge usage"); } };
  const wrapped = createGovernedChildProvider(raw.provider, ctx), input = request();
  assert.equal(wrapped.inputBindingDigest?.(input), A);
  assert.deepEqual(raw.bindings, [input]);
});

test("retained child binding belongs to the forked transport and disappears after close", () => {
  const parent = transport(A), child = transport(B);
  let forks = 0;
  const session = createChildProviderSession({ ...parent.provider, fork: () => {
    forks++;
    return child.provider;
  } });
  const input = request();
  assert.equal(session.provider.inputBindingDigest?.(input), B);
  assert.equal(forks, 1);
  assert.equal(parent.bindings.length, 0);
  assert.deepEqual(child.bindings, [input]);
  session.close();
  assert.equal(session.provider.inputBindingDigest?.(input), undefined);
  assert.equal(child.bindings.length, 1, "released child state must not certify a request");
});

test("normal main wrapper stack preserves prepared request equivalence without repeated preparation", async t => {
  const raw = transport();
  let inspections = 0;
  const wrapped = personal(discoveryProvider(withImageReferences(raw.provider, "unused-no-image-root"), () => true), () => { inspections++; });
  const tools = createFakeTools([], []), built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools,
    parentProvider: wrapped, childProvider: raw.provider, permission: createFakePermission("approved"), model: "local-binding", callerMessages: undefined });

  t.after(async () => { await built.runtime.cancelAll(); });
  const input = request(), preparation = await built.provider.prepareRequest!(input, signal), prepared = preparation.apply(input);

  assert.equal(inspections, 1);
  assert.equal(built.provider.inputBindingDigest?.(prepared), A);
  assert.equal(inspections, 1, "pure binding must not prepare guidance again");

  for await (const _event of built.provider.stream(prepared, signal)) { /* local fixture only */ }

  assert.deepEqual(raw.bindings.at(-1), raw.sends.at(-1));
  assert.equal(inspections, 1);
});

for (const dispatchWrapper of [false, true]) test(`interactive child retains binding with dispatch wrapper ${dispatchWrapper}`, async () => {
  const raw = transport();
  const worker = createInteractiveChildWorker({ provider: raw.provider, permission: createFakePermission("approved"),
    message: "Complete the local assigned task.", model: "local-binding",
    ...(dispatchWrapper ? { onRequestDispatched: async () => {} } : {}) });
  const result = await worker(context());

  assert.equal(result.status, "completed");
  assert.equal(raw.sends.length, 1);
  assert.ok(raw.bindings.length > 0, "actual child loop cannot lose its provider-owned input binding");
  assert.ok(raw.bindings.every(value => value.model === raw.sends[0]?.model));
});

test("legacy providers without binding remain unsupported through the same wrappers", () => {
  const legacy: ProviderPort = { async *stream() { yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const child = createChildProviderSession(legacy);
  const wrappers = [withImageReferences(legacy, "unused"), personal(legacy), discoveryProvider(legacy, () => false),
    createGovernedChildProvider(legacy, context()), child.provider];
  for (const wrapped of wrappers) assert.equal(wrapped.inputBindingDigest, undefined);
  child.close();
});
