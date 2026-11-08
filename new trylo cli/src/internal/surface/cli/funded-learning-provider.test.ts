import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createWarmRegistry } from "../../adapters/provider/warm.js";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import { buildProvider } from "./provider-build.js";
import { buildLearningProvider } from "./funded-learning-provider.js";

const selection = { providerId: "synthetic-learning", model: "synthetic", apiKey: "synthetic-not-a-credential",
  endpoint: "https://unit.invalid/model", workspaceRoot: "D:/learning-provider-fixture" };
const request = { attemptId: "one-learning-call", model: selection.model, messages: [], tools: [], maxOutputTokens: 100 };

async function consume(provider: ProviderPort) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) events.push(event);
  return events;
}

for (const kind of ["openai-compatible", "openai-responses"] as const) {
  test(`funded single_request ${kind} does not replay a model POST on native fetch 307`, async t => {
    let posts = 0;
    const server = createServer((incoming, response) => {
      if (incoming.method === "POST") posts += 1;

      incoming.resume();

      if (incoming.url === "/redirect") {
        response.writeHead(307, { location: "/final" });
        response.end();
      } else {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const input = { ...selection, providerKind: kind, endpoint: `http://127.0.0.1:${address.port}/redirect` };
    const parent = buildProvider(input);
    assert.ok(!("code" in parent));
    const learning = buildLearningProvider(input, parent);
    assert.ok(!("code" in learning));
    assert.equal((await consume(learning)).at(-1)?.type, "error");
    assert.equal(posts, 1, "a 307 cannot send a second model POST under the same reservation");

    if (kind === "openai-compatible") {
      posts = 0;
      await consume(parent);
      assert.equal(posts, 2, "ordinary transport retains native redirect follow");
    }
  });
}

for (const kind of ["openai-compatible", "openai-responses"] as const) {
  for (const failure of ["network", 503, 429, 401] as const) {
    test(`new learning transport ${kind} does not retry ${failure}, including after fork`, async t => {
      const originalFetch = globalThis.fetch;
      let posts = 0, refreshes = 0;

      globalThis.fetch = async (_url, init) => {
        assert.equal(init?.method, "POST");
        posts += 1;
        if (failure === "network") throw new Error("synthetic pre-header transport loss");
        return new Response("{}", { status: failure });
      };
      t.after(() => { globalThis.fetch = originalFetch; });
      const input = { ...selection, providerKind: kind, tokenManager: {
        getValidAccessToken: async () => "synthetic-token", handleAuthError: async () => {
          refreshes += 1;
          return { refreshed: true as const, token: "synthetic-renewed-token" };
        } } };
      const parent = buildProvider(input);
      assert.ok(!("code" in parent));
      const learning = buildLearningProvider(input, parent);
      assert.ok(!("code" in learning));
      assert.equal((await consume(learning)).at(-1)?.type, "error");
      assert.equal(posts, 1);
      const fork = learning.fork?.([]);
      assert.ok(fork && fork !== learning);
      assert.equal((await consume(fork)).at(-1)?.type, "error");
      assert.equal(posts, 2);
      assert.equal(refreshes, 0, "a 401 cannot buy another model request inside this reservation");
    });
  }
}

test("the learning factory retains the caller guard and separates warm policy while normal auth retry remains", async t => {
  const originalFetch = globalThis.fetch;
  let posts = 0, refreshes = 0, guards = 0, learningCall = false;

  globalThis.fetch = async () => {
    posts += 1;
    return learningCall || posts === 1 ? new Response("{}", { status: 401 })
      : new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const warm = createWarmRegistry({ now: () => 0 });
  const input = { ...selection, providerKind: "openai-compatible" as const, warm,

    providerGuard: (provider: ProviderPort) => {
      guards += 1;
      return provider;
    }, tokenManager: {
      getValidAccessToken: async () => "synthetic-token", handleAuthError: async () => {
        refreshes += 1;
        return { refreshed: true as const, token: "synthetic-renewed-token" };
      } } };
  const parent = buildProvider(input);
  assert.ok(!("code" in parent));
  const learning = buildLearningProvider(input, parent);
  assert.ok(!("code" in learning));
  assert.equal(warm.stats().builds, 2);
  assert.equal(guards, 2);
  await consume(parent);
  assert.equal(posts, 2);
  assert.equal(refreshes, 1);
  learningCall = true;
  await consume(learning);
  assert.equal(posts, 3);
  assert.equal(refreshes, 1);
});

test("an already single-request parent is reused without reconstructing its caller guard", async () => {
  let guards = 0;
  const warm = createWarmRegistry({ now: () => 0 });
  const input = { ...selection, providerKind: "openai-compatible" as const, warm, requestAttemptPolicy: "single_request" as const,

    providerGuard: (provider: ProviderPort) => {
      guards += 1;
      return provider;
    } };
  const parent = buildProvider(input);
  assert.ok(!("code" in parent));
  assert.equal(buildLearningProvider(input, parent), parent);
  assert.equal(guards, 1);
  assert.equal(warm.stats().builds, 1);
});
