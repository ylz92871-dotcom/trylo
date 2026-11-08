import assert from "node:assert/strict";
import test from "node:test";
import { withImageReferences } from "../adapters/media/image-reference-provider.js";
import { discoveryProvider } from "../adapters/mcp-runtime/discovery-provider.js";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { createResponsesProvider } from "../adapters/provider/responses.js";
import { withSkillLearningGrant } from "../integration/skill-learning/grant-provider.js";
import { withSkillCentralFunding } from "../learning/agent/subsystems/skill/host/funded-provider.js";
import { withToolLearningFunding } from "../learning/agent/subsystems/tool/adapters/evolution/funded-provider.js";
import type { ProviderMessage, ProviderPort, ProviderRequest } from "../ports/provider.js";
import { createPersonalAgentProvider } from "../surface/cli/collaboration-parent-context.js";

const target = "qwen3.8-flash";
const request: ProviderRequest = { attemptId: "fork-options", model: "", messages: [{ role: "user", content: "Finish." }], tools: [] };
const forkFor = (provider: ProviderPort) => {
  const fork: (history?: readonly ProviderMessage[], options?: { readonly model: string }) => ProviderPort = provider.fork!;
  return fork([], { model: target });
};

test("both transport forks bind an omitted request model to their resolved target", async t => {
  for (const family of ["chat", "responses"] as const) await t.test(family, async () => {
    let actual: string | undefined, reported: string | undefined;
    const config = { endpoint: "https://synthetic.invalid/v1/" + family, model: "plain-parent", apiKey: "synthetic-no-network",
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        actual = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(family === "chat" ? 'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          : 'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
      } };
    const parent = family === "chat" ? createOpenAiCompatibleProvider(config) : createResponsesProvider(config);
    for await (const event of forkFor(parent).stream(request, new AbortController().signal)) {
      if (event.type === "error") assert.fail(event.class);
      if (event.type === "stream_start") reported = event.model;
    }
    assert.equal(actual, target);
    assert.equal(reported, actual);
  });
});

function identityProvider(model = "plain-parent"): ProviderPort {
  const fork = (_history?: readonly ProviderMessage[], options?: { readonly model: string }) => identityProvider(options?.model ?? model);
  return { fork,
    continuation: { capture: () => undefined, restore: () => {}, measureRequestIdentity: input => ({ requestDigest: model,
      messageFieldDigests: input.messages.map(() => model), messageOverheadTokens: input.messages.map(() => 0) }) },
    async *stream() { throw new Error("Fork identity checks must not make funded or network requests"); } };
}

test("all six maintained fork wrappers preserve the selected model's continuation identity", async t => {
  const source = identityProvider();
  const unavailable = (): never => { throw new Error("Forking must not read grants or spend an allowance"); };
  const wrappers: [string, ProviderPort][] = [
    ["images", withImageReferences(source, "C:/synthetic-unused-workspace")],
    ["MCP", discoveryProvider(source, () => true)],
    ["personal", createPersonalAgentProvider({ provider: source, scope: "fork-identity", turnId: "turn", now: () => "2026-11-08T00:00:00Z",
      get experience(): never { return unavailable(); }, warn: unavailable, inspect: unavailable, recentFacts: unavailable })],
    ["skill grant", withSkillLearningGrant(source, { get runtime(): never { return unavailable(); }, grantId: "synthetic", reservationIdFactory: unavailable })],
    ["central skill", withSkillCentralFunding(source, { get funding(): never { return unavailable(); }, newId: unavailable })],
    ["tool funding", withToolLearningFunding(source, { get funding(): never { return unavailable(); }, newId: unavailable })],
  ];
  for (const [name, wrapped] of wrappers) await t.test(name, () => {
    const selected = forkFor(wrapped);
    assert.equal(selected.continuation?.measureRequestIdentity?.(request).requestDigest, target);
  });
});

test("legacy one-argument providers remain assignable and callers may omit fork options", () => {
  const legacy: ProviderPort = { fork: (_history?: readonly ProviderMessage[]) => identityProvider(), async *stream() {} };
  const compatible: (history?: readonly ProviderMessage[], options?: { readonly model: string }) => ProviderPort = legacy.fork!;
  assert.equal(compatible([]).continuation?.measureRequestIdentity?.(request).requestDigest, "plain-parent");
  assert.equal(compatible([], { model: target }).continuation?.measureRequestIdentity?.(request).requestDigest, "plain-parent",
    "legacy adapters may ignore the additive optional capability; construction must remain compatible");
});

test("empty-target fork options preserve each transport's configured model", async t => {
  for (const family of ["chat", "responses"] as const) await t.test(family, async () => {
    let actual: string | undefined;
    const config = { endpoint: "https://synthetic.invalid/v1/" + family, model: "plain-parent", apiKey: "synthetic-no-network",
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        actual = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(family === "chat" ? 'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          : 'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
      } };
    const parent = family === "chat" ? createOpenAiCompatibleProvider(config) : createResponsesProvider(config);
    const fork: (history?: readonly ProviderMessage[], options?: { readonly model: string }) => ProviderPort = parent.fork!;
    for await (const event of fork([], { model: "" }).stream(request, new AbortController().signal)) {
      if (event.type === "error") assert.fail(event.class);
    }
    assert.equal(actual, "plain-parent");
  });
});
