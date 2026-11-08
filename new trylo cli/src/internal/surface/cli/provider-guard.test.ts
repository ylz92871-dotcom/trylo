import test from "node:test";
import assert from "node:assert/strict";
import { createWarmRegistry } from "../../adapters/provider/warm.js";
import type { ProviderPort } from "../../ports/provider.js";
import { buildProvider } from "./provider-build.js";

const base = { providerId: "fixture", model: "fixture", endpoint: "", apiKey: undefined, workspaceRoot: "D:/guard-test" };

test("provider guard wraps the constructed provider before a stream can be opened", () => {
  let guards = 0;
  const guarded: ProviderPort = { stream: () => { throw new Error("test does not send a request"); } };
  const actual = buildProvider({ ...base, providerGuard: provider => {
    assert.equal(typeof provider.stream, "function");
    guards += 1;
    return guarded;
  } });

  assert.equal(actual, guarded);
  assert.equal(guards, 1);
});

test("warm provider reuse never caches another grant's guard", () => {
  const warm = createWarmRegistry({ now: () => 1 });
  const raw: ProviderPort[] = [], guarded: ProviderPort[] = [];
  const providerGuard = (provider: ProviderPort): ProviderPort => {
    raw.push(provider);
    const wrapper: ProviderPort = { stream: (request, signal) => provider.stream(request, signal) };
    guarded.push(wrapper);
    return wrapper;
  };
  const first = buildProvider({ ...base, warm, providerGuard }), second = buildProvider({ ...base, warm, providerGuard });

  assert.equal(raw.length, 2);
  assert.equal(raw[0], raw[1]);
  assert.notEqual(first, second);
  assert.equal(first, guarded[0]);
  assert.equal(second, guarded[1]);
  assert.equal(warm.stats().builds, 1);
});

for (const status of [503, 401]) test(`an explicit single-request transport cannot retry HTTP ${status} inside its reservation`, async t => {
  const original = globalThis.fetch;
  let fetches = 0;

  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(JSON.stringify({ error: { message: "test refusal" } }), { status });
  };
  t.after(() => { globalThis.fetch = original; });
  const warm = createWarmRegistry({ now: () => 1 });
  const connection = { providerId: "test", providerKind: "openai-compatible" as const, model: "test",
    endpoint: "https://unit.invalid/chat/completions", apiKey: "test-key", workspaceRoot: base.workspaceRoot, warm };

  buildProvider(connection);
  const provider = buildProvider({ ...connection,
    endpoint: "https://unit.invalid/chat/completions", apiKey: "test-key", workspaceRoot: base.workspaceRoot,
    requestAttemptPolicy: "single_request",
    providerGuard: raw => raw,
    ...(status !== 401 ? {} : { tokenManager: { getValidAccessToken: async () => "test-key",
      handleAuthError: async () => ({ refreshed: true, token: "test-renewed" }) } }) });

  assert.ok(!("code" in provider));

  for await (const event of provider.stream({ attemptId: "call", model: "test", messages: [], tools: [], maxOutputTokens: 10 }, new AbortController().signal)) void event;

  assert.equal(fetches, 1);
  assert.equal(warm.stats().builds, 2, "an explicit single-request transport cannot borrow the ordinary warm transport");
});

test("a generic provider guard retains ordinary auth refresh and warm retry policy", async t => {
  const original = globalThis.fetch;
  let fetches = 0, refreshes = 0;

  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1 ? new Response(JSON.stringify({ error: { message: "test expired credential" } }), { status: 401 })
      : new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => { globalThis.fetch = original; });
  const warm = createWarmRegistry({ now: () => 1 });
  const connection = { providerId: "test", providerKind: "openai-compatible" as const, model: "test",
    endpoint: "https://unit.invalid/chat/completions", apiKey: "test-key", workspaceRoot: base.workspaceRoot, warm,
    tokenManager: { getValidAccessToken: async () => "test-key", handleAuthError: async () => {
      refreshes += 1;
      return { refreshed: true as const, token: "test-renewed" };
    } } };
  const provider = buildProvider({ ...connection, providerGuard: value => value }), raw = buildProvider(connection);

  assert.equal(raw, provider);
  assert.ok(!("code" in provider));

  for await (const event of provider.stream({ attemptId: "ordinary", model: "test", messages: [], tools: [], maxOutputTokens: 10 }, new AbortController().signal)) void event;

  assert.equal(fetches, 2);
  assert.equal(refreshes, 1);
  assert.equal(warm.stats().builds, 1);
});
