import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { ToolCallRequest, ToolOutcome } from "../../../../ports/tools.js";
import type { JsonObject } from "../../../../protocol/envelope.js";
import type { WebSearchPort, WebSearchRequest } from "../../../../ports/web-search.js";
import { createHostedSearchBackend } from "./hosted-backend.js";
import { planWebSearch } from "./plan.js";
import { createWebSearchTool } from "./index.js";

/**
 * `web_search`, against a real HTTP server standing in for a provider.
 *
 * The tests are organised around the ways a search tool can lie, because that is
 * the only thing this tool has to be careful about:
 *
 *  - **it can answer without searching** — a backend with no endpoint must not
 *    exist at all, so the tool is never mounted with nothing behind it;
 *  - **it can answer without a source** — a provider that ignores the hosted tool
 *    still returns fluent text, and returning that text as a search result is the
 *    failure this whole file exists to prevent;
 *  - **it can answer the wrong question** — which is why the request body is read
 *    back here rather than assumed;
 *  - **it can downgrade what it promised** — a `live` search quietly answered from
 *    an index is a false statement about freshness.
 */

type Captured = { readonly body: Record<string, unknown> | undefined; readonly auth: string | undefined };

function startProvider(
  respond: (body: Record<string, unknown> | undefined) => { status: number; payload: unknown },
): Promise<{ base: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> | undefined;

      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = undefined;
      }

      captured.push({ body, auth: req.headers.authorization });
      const answer = respond(body);

      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        base: `http://127.0.0.1:${port}/responses`,
        captured,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

const CITED = {
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Node 22 ships fetch as stable.",
          annotations: [
            { type: "url_citation", url: "https://nodejs.org/en/blog/release/v22.0.0", title: "Node v22.0.0" },
          ],
        },
      ],
    },
  ],
};

function backendFor(base: string, allowExternalWeb = false): WebSearchPort {
  const created = createHostedSearchBackend({
    endpoint: base,
    model: "test-model",
    apiKey: "sk-test",
    providerId: "openai-responses",
    allowExternalWeb,
  });

  assert.ok(created !== undefined, "an endpoint means a backend exists");

  return created;
}

function request(over: Partial<WebSearchRequest> = {}): WebSearchRequest {
  return { query: "node 22 fetch stable", mode: "cached", ...over };
}

function call(args: JsonObject, name = "web_search"): ToolCallRequest {
  return { toolCallId: "s-1", name, arguments: args };
}

test("no endpoint means no backend at all, so the tool cannot be mounted empty", () => {
  assert.equal(createHostedSearchBackend({ model: "m", apiKey: "k" }), undefined);
  assert.equal(
    createHostedSearchBackend({ endpoint: "", model: "m", apiKey: "k" }),
    undefined,
    "an empty endpoint is not an endpoint",
  );
});

test("a real query returns the answer with its sources, and sends the query on the wire", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const outcome = await backendFor(server.base).search(request(), new AbortController().signal);

    assert.equal(outcome.ok, true);

    if (outcome.ok) {
      assert.equal(outcome.result.sources.length, 1);
      assert.equal(outcome.result.sources[0]?.url, "https://nodejs.org/en/blog/release/v22.0.0");
      assert.match(outcome.result.answer, /fetch as stable/);
    }

    const sent = server.captured[0];

    assert.match(String(sent?.body?.["input"]), /node 22 fetch stable/);
    assert.equal(sent?.auth, "Bearer sk-test");
  } finally {
    await server.close();
  }
});

test("an answer with no cited source is refused, not returned as a search result", async () => {
  // The single most important case in this file: a provider that ignores the
  // hosted tool still answers, and that answer is indistinguishable from a real
  // one unless the tool insists on a citation.
  const server = await startProvider(() => ({
    status: 200,
    payload: { output: [{ type: "message", content: [{ type: "output_text", text: "I believe it is fine.", annotations: [] }] }] },
  }));
  try {
    const outcome = await backendFor(server.base).search(request(), new AbortController().signal);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, "empty_result");
    }
  } finally {
    await server.close();
  }
});

test("a live search is refused when live access is off, rather than silently downgraded", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const outcome = await backendFor(server.base).search(
      request({ mode: "live" }),
      new AbortController().signal,
    );

    assert.equal(outcome.ok, false);

    if (!outcome.ok) {
      assert.equal(outcome.code, "unavailable");
    }

    assert.equal(server.captured.length, 0, "a refused mode must not reach the provider");
  } finally {
    await server.close();
  }
});

test("a live search that is enabled says so on the wire", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const outcome = await backendFor(server.base, true).search(
      request({ mode: "live" }),
      new AbortController().signal,
    );

    assert.equal(outcome.ok, true);
    const tools = server.captured[0]?.body?.["tools"] as ReadonlyArray<Record<string, unknown>>;

    assert.equal(tools[0]?.["type"], "web_search");
    assert.equal(tools[0]?.["external_web_access"], true);
  } finally {
    await server.close();
  }
});

test("provider failures map to the shared classifier, not to a second opinion", async () => {
  for (const [status, code] of [
    [401, "auth"],
    [429, "rate_limit"],
    [400, "network"],
    [500, "network"],
  ] as ReadonlyArray<readonly [number, string]>) {
    const server = await startProvider(() => ({ status, payload: {} }));
    try {
      const outcome = await backendFor(server.base).search(request(), new AbortController().signal);
      assert.equal(outcome.ok, false, String(status));
      if (!outcome.ok) {
        assert.equal(outcome.code, code, String(status));
      }
    } finally {
      await server.close();
    }
  }
});

test("a domain filter reaches the wire, and the two lists never both do", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const port = createWebSearchTool(backendFor(server.base));

    await port.execute(call({ query: "node fetch", allowed_domains: ["nodejs.org"] }), new AbortController().signal);
    const tools = server.captured[0]?.body?.["tools"] as ReadonlyArray<Record<string, unknown>>;

    assert.deepEqual(tools[0]?.["filters"], { allowed_domains: ["nodejs.org"] });

    const both = await port.execute(
      call({ query: "node fetch", allowed_domains: ["a.test"], blocked_domains: ["b.test"] }),
      new AbortController().signal,
    );

    assert.equal(both.outcome, "error");
    assert.equal((both as { code: string }).code, "conflicting_filters");
    assert.equal(server.captured.length, 1, "the refused call never reached the provider");
  } finally {
    await server.close();
  }
});

test("a short query and a bad mode are refused before any request", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const port = createWebSearchTool(backendFor(server.base));

    for (const args of [{ query: "x" }, { query: "long enough", mode: "turbo" }, {}]) {
      const outcome = await port.execute(call(args), new AbortController().signal);
      assert.equal(outcome.outcome, "error", JSON.stringify(args));
      assert.equal((outcome as { code: string }).code, "invalid_arguments");
    }

    assert.equal(server.captured.length, 0);
  } finally {
    await server.close();
  }
});

test("the tool renders sources as links and reports them in value too", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const port = createWebSearchTool(backendFor(server.base));
    const outcome = (await port.execute(call({ query: "node" }), new AbortController().signal)) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.equal(outcome.outcome, "result");
    assert.match(outcome.output, /\[Node v22\.0\.0\]\(https:\/\/nodejs\.org/);
    assert.match(outcome.output, /Include these links/);
    const sources = outcome.value["sources"] as ReadonlyArray<{ url: string }>;

    assert.equal(sources[0]?.url, "https://nodejs.org/en/blog/release/v22.0.0");
    assert.equal(outcome.value["sourceCount"], 1);
  } finally {
    await server.close();
  }
});

test("a foreign tool name answers unknown rather than searching anyway", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const port = createWebSearchTool(backendFor(server.base));
    const outcome = await port.execute(call({}, "todo_write"), new AbortController().signal);
    assert.equal(outcome.outcome, "unknown");
    assert.equal(server.captured.length, 0);
  } finally {
    await server.close();
  }
});

test("a cancelled search never reaches the provider", async () => {
  const server = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const controller = new AbortController();
    controller.abort();
    const outcome = await backendFor(server.base).search(request(), controller.signal);
    assert.equal(outcome.ok, false);
    assert.equal(server.captured.length, 0);
  } finally {
    await server.close();
  }
});

test("planWebFetch-shaped validation: a query of two characters is the floor", () => {
  assert.equal(planWebSearch(call({ query: "ab" })).ok, true);
  assert.equal(planWebSearch(call({ query: "a" })).ok, false);
});

test("the account's refreshed token is the one sent, not the stored copy", async () => {
  // F5: within one run the conversation and `web_search` must not disagree about
  // credential freshness. If the conversation refreshed and the search request
  // sent the stale copy, the user sees one tool succeed and the other 401 with
  // nothing to explain it.
  const provider = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const created = createHostedSearchBackend({
      endpoint: provider.base,
      model: "test-model",
      apiKey: "sk-stale",
      providerId: "openai-responses",
      allowExternalWeb: false,
      tokenManager: {
        getValidAccessToken: async () => "sk-fresh",
        handleAuthError: async () => ({ refreshed: false }),
      },
    });

    assert.ok(created !== undefined);
    await created.search(request(), new AbortController().signal);
    assert.equal(provider.captured[0]?.auth, "Bearer sk-fresh");
  } finally {
    await provider.close();
  }
});

test("a token manager that fails falls back to the stored key rather than to no credential", async () => {
  // The Responses path does the same (`responses.ts`): a failing refresh is not
  // a reason to send no Authorization header at all, which would read as an
  // unauthenticated request rather than as the retry it is.
  const provider = await startProvider(() => ({ status: 200, payload: CITED }));
  try {
    const created = createHostedSearchBackend({
      endpoint: provider.base,
      model: "test-model",
      apiKey: "sk-stored",
      providerId: "openai-responses",
      allowExternalWeb: false,
      tokenManager: {
        getValidAccessToken: async () => {
          throw new Error("refresh failed");
        },
        handleAuthError: async () => ({ refreshed: false }),
      },
    });

    assert.ok(created !== undefined);
    await created.search(request(), new AbortController().signal);
    assert.equal(provider.captured[0]?.auth, "Bearer sk-stored");
  } finally {
    await provider.close();
  }
});
