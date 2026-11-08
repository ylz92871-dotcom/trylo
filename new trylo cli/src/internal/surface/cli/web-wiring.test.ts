import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { createDenyAllPermission } from "./permission.js";
import { webBackendsFor } from "./web-wiring.js";
import { wirePorts } from "./wiring.js";

/**
 * WP20 F2/F3: the production construction path, not the injected one.
 *
 * Every other web test builds the tools by handing `createWebTools` a literal
 * config — an extractor, a clock, a fetch. That proves the parts work and says
 * nothing about whether a *run* ever supplies them, which is exactly the gap F2
 * and F3 live in: `prompt` was advertised and refused 100% of the time, and the
 * cache did not exist, while 60 tests stayed green. So these tests enter through
 * `wirePorts` / `webBackendsFor` — the two functions a real run passes through.
 */

type Site = { readonly base: string; readonly close: () => Promise<void> };

/**
 * A local origin, so a test never depends on the network being up.
 *
 * `createWebTools` takes a `doFetch` seam, but the composition root forwards
 * no such seam, so this server is reached through the real global `fetch`. On
 * `127.0.0.1` that is hermetic: the one host a test may always open a socket to.
 */
function startSite(): Promise<Site> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Quiet Title</h1><p>body text</p></body></html>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}/page`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function wiringWith(web: ReturnType<typeof webBackendsFor>) {
  return wirePorts({
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
    allowWeb: true,
    web,
  });
}

function webFetchBinding(tools: { snapshot: () => readonly { name: string }[] }) {
  return tools.snapshot().find((binding) => binding.name === "web_fetch");
}

test("a real run's web_fetch answers a prompt: the extractor is wired, not just injectable", async () => {
  // The composition root is what owns a live provider, so it is what must attach
  // the extractor. `webBackendsFor` cannot: it knows which provider was
  // selected, not one that exists.
  const site = await startSite();
  try {
    const wiring = wiringWith(webBackendsFor({
      providerKind: "fixture",
      endpoint: "",
      model: "default",
      apiKey: undefined,
    }));

    assert.equal("code" in wiring, false);

    if ("code" in wiring) {
      return;
    }

    assert.notEqual(webFetchBinding(wiring.ports.tools), undefined);

    // Asserting the schema advertises `prompt` would prove nothing: the binding
    // is a module-level const, so it goes on advertising `prompt` whether or not
    // an extractor exists. An earlier version of this test asserted exactly that
    // and stayed green with the wiring pulled out — a red example caught it.
    // What has to be observed is whether the call survives planning at all.
    const answer = await wiring.ports.tools.execute(
      {
        toolCallId: "wp20-f2-probe",
        name: "web_fetch",
        arguments: { url: site.base, prompt: "What is the title?" },
      },
      new AbortController().signal,
    );

    // The invariant is not "the extractor produced text" — that depends on what
    // the provider answers, and a fixture provider is entitled to say nothing.
    // It is "the call was not refused up front": with no extractor, `plan.ts`
    // rejects a `prompt` before the fetch with `extraction_unavailable`, and no
    // amount of provider behaviour can change that. Reaching a result at all is
    // the proof the wiring exists.
    if (answer.outcome === "error") {
      assert.fail(`web_fetch refused an advertised prompt: ${answer.code} ${answer.message}`);
    }

    assert.equal(answer.outcome, "result");
  } finally {
    await site.close();
  }
});

test("a real run has a cache: the clock is injected at the composition root", () => {
  // Absent a clock the tool builds no cache at all, so `fromCache` could only
  // ever appear in a test. A run that mounted the tool has one.
  const config = webBackendsFor({
    providerKind: "fixture",
    endpoint: "",
    model: "default",
    apiKey: undefined,
  });

  assert.equal(typeof config.nowMs, "function");
  // A real clock, not a frozen one: the number it hands out is a real timestamp.
  assert.ok((config.nowMs?.() ?? 0) > 0, "a production clock is not the epoch");
});

test("the cache clock can be held still without patching a global", () => {
  // The seam exists so a test can own time. If this stopped working, the only
  // way to test expiry would be to wait out the fifteen-minute TTL.
  let now = 1_000;
  const config = webBackendsFor({
    providerKind: "fixture",
    endpoint: "",
    model: "default",
    apiKey: undefined,
    nowMs: () => now,
  });

  assert.equal(config.nowMs?.(), 1_000);
  now = 2_000;
  assert.equal(config.nowMs?.(), 2_000);
});

test("a provider that cannot search still gets a cache, and no web_search", () => {
  // Three states stay three states. `fixture` has no hosted search, so the tool
  // is absent rather than present-and-broken — and the cache, which needs no
  // provider, is still there.
  const config = webBackendsFor({
    providerKind: "fixture",
    endpoint: "",
    model: "default",
    apiKey: undefined,
  });

  assert.equal(config.search, undefined);
  assert.equal(typeof config.nowMs, "function");
});

test("no web config at all means no network tool and no extractor", () => {
  // R1: an absent field constructs nothing. A default run must not grow a
  // network tool, and its catalog hash must not move.
  const wiring = wirePorts({
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
  });

  assert.equal("code" in wiring, false);

  if ("code" in wiring) {
    return;
  }

  const names = wiring.ports.tools.snapshot().map((binding) => binding.name);

  assert.equal(names.includes("web_fetch"), false);
  assert.equal(names.includes("web_search"), false);
});
