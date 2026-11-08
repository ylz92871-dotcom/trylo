import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { ToolOutcome } from "../../../ports/tools.js";
import { WEB_FETCH_TOOL } from "./names.js";
import { createWebTools } from "./index.js";
import { extractWithPrompt, type PageExtractor } from "./extract-prompt.js";

/**
 * `web_fetch` end to end against local servers: the five steps of a fetch, and the
 * cases a permissive implementation gets wrong.
 *
 * The two that matter most are the first two arms. A redirect to another host that
 * gets followed is an approved fetch to one host silently becoming a fetch to
 * another; and a cached page that is served past its TTL is the tool answering with
 * a fact about the past while claiming it is about the present.
 */

type Site = {
  readonly base: string;
  readonly hits: () => number;
  readonly close: () => Promise<void>;
};

function startSite(): Promise<Site> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/away") {
      res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      res.end();
      return;
    }

    if (path === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }

    if (path === "/same") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }

    if (path === "/final") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><p>arrived</p></body></html>");
      return;
    }

    if (path === "/binary") {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(Buffer.alloc(64, 3));
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><p>origin page</p><script>alert('x')</script></body></html>");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        base: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

function call(url: string, extra: Record<string, string> = {}): {
  toolCallId: string;
  name: string;
  arguments: Record<string, string>;
} {
  return { toolCallId: "f-1", name: WEB_FETCH_TOOL, arguments: { url, ...extra } };
}

const signal = new AbortController().signal;

test("a same-host redirect is followed and the page comes back as prose", async () => {
  const site = await startSite();
  try {
    const port = createWebTools();
    const outcome = (await port.execute(call(`${site.base}/same`), signal)) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.equal(outcome.outcome, "result");
    assert.match(outcome.output, /arrived/);
  } finally {
    await site.close();
  }
});

test("a redirect to another host is reported with both URLs and never followed", async () => {
  const site = await startSite();
  try {
    const port = createWebTools();
    const before = site.hits();
    const outcome = (await port.execute(call(`${site.base}/away`), signal)) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.equal(outcome.outcome, "result", "a refused hop is a decision, not a failure");
    assert.equal(outcome.value["followed"], false);
    assert.match(String(outcome.value["redirectUrl"]), /127\.0\.0\.1:1/);
    assert.match(outcome.output, /did not follow a redirect/);
    assert.equal(site.hits(), before + 1, "only the first hop was ever requested");
  } finally {
    await site.close();
  }
});

test("a redirect loop is capped rather than hanging the turn", async () => {
  const site = await startSite();
  try {
    const port = createWebTools({ timeoutMs: 5_000 });
    const outcome = await port.execute(call(`${site.base}/loop`), signal);
    assert.equal(outcome.outcome, "error");
    assert.equal((outcome as { code: string }).code, "too_many_redirects");
    assert.ok(site.hits() <= 12, `expected a bounded hop count, saw ${site.hits()}`);
  } finally {
    await site.close();
  }
});

test("binary content is refused, not half-decoded", async () => {
  const site = await startSite();
  try {
    const port = createWebTools();
    const outcome = await port.execute(call(`${site.base}/binary`), signal);
    assert.equal(outcome.outcome, "error");
    assert.equal((outcome as { code: string }).code, "unsupported_content");
  } finally {
    await site.close();
  }
});

test("a repeated URL is served from the cache and says so; an expired one is re-fetched", async () => {
  const site = await startSite();
  try {
    let now = 0;
    const port = createWebTools({ nowMs: () => now });
    const first = (await port.execute(call(`${site.base}/page`), signal)) as Extract<ToolOutcome, { outcome: "result" }>;

    assert.equal(first.value["fromCache"], false);
    const afterFirst = site.hits();

    const second = (await port.execute(call(`${site.base}/page`), signal)) as Extract<ToolOutcome, { outcome: "result" }>;

    assert.equal(second.value["fromCache"], true);
    assert.equal(site.hits(), afterFirst, "a cache hit must not touch the network");

    // Past the 15-minute default TTL, not merely past ten minutes.
    now = 16 * 60 * 1000;
    const third = (await port.execute(call(`${site.base}/page`), signal)) as Extract<ToolOutcome, { outcome: "result" }>;

    assert.equal(third.value["fromCache"], false, "past the TTL the page is fetched again");
    assert.equal(site.hits(), afterFirst + 1);
  } finally {
    await site.close();
  }
});

test("without a clock there is no cache, so every call really fetches", async () => {
  const site = await startSite();
  try {
    const port = createWebTools();
    await port.execute(call(`${site.base}/page`), signal);
    const after = site.hits();
    await port.execute(call(`${site.base}/page`), signal);
    assert.equal(site.hits(), after + 1);
  } finally {
    await site.close();
  }
});

test("prompt is refused before the fetch when no extractor was lent", async () => {
  const site = await startSite();
  try {
    const port = createWebTools();
    const before = site.hits();
    const outcome = await port.execute(call(`${site.base}/page`, { prompt: "what is this?" }), signal);
    assert.equal(outcome.outcome, "error");
    assert.equal((outcome as { code: string }).code, "extraction_unavailable");
    assert.equal(site.hits(), before, "a call that cannot be honoured must not reach the network");
  } finally {
    await site.close();
  }
});

test("with an extractor, prompt returns the answer and marks the result as extracted", async () => {
  const site = await startSite();
  try {
    const asked: string[] = [];
    const extractor: PageExtractor = async (page, prompt) => {
      asked.push(prompt);
      assert.match(page, /origin page/);
      return "It is the origin page.";
    };
    const port = createWebTools({ extractor });
    const outcome = (await port.execute(call(`${site.base}/page`, { prompt: "what is this?" }), signal)) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.equal(outcome.output, "It is the origin page.");
    assert.equal(outcome.value["extracted"], true);
    assert.deepEqual(asked, ["what is this?"]);
    assert.equal(outcome.value["url"], `${site.base}/page`, "provenance survives extraction");
  } finally {
    await site.close();
  }
});

test("an extractor that fails yields the page, flagged as unextracted", async () => {
  const site = await startSite();
  try {
    const port = createWebTools({
      extractor: async () => {
        throw new Error("provider refused");
      },
    });
    const outcome = (await port.execute(call(`${site.base}/page`, { prompt: "q" }), signal)) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.match(outcome.output, /origin page/, "the page is still the answer");
    assert.equal(outcome.value["extracted"], false);
    assert.match(String(outcome.value["extractionNote"]), /provider refused/);
  } finally {
    await site.close();
  }
});

test("an empty extraction is treated as no extraction at all", async () => {
  const site = await startSite();
  try {
    const port = createWebTools({ extractor: async () => "   " });
    const outcome = (await port.execute(call(`${site.base}/page`, { prompt: "q" }), signal)) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.match(outcome.output, /origin page/);
    assert.equal(outcome.value["extracted"], false);
  } finally {
    await site.close();
  }
});

test("no web_search in the catalog unless a backend was lent", () => {
  const names = createWebTools().snapshot().map((binding) => binding.name);
  assert.deepEqual(names, [WEB_FETCH_TOOL]);
});

test("extractWithPrompt truncates an oversized page and says so", async () => {
  const long = "x".repeat(120_000);
  let seenLength = 0;
  const outcome = await extractWithPrompt({
    extractor: async (page) => {
      seenLength = page.length;
      return "answer";
    },
    page: long,
    prompt: "q",
    signal,
  });

  assert.equal(outcome.kind, "extracted");
  assert.equal(seenLength, 100_000);

  if (outcome.kind === "extracted") {
    assert.equal(outcome.truncated, true);
  }
});
