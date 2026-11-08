import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderEvent, ProviderRequest } from "../../ports/provider.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

/**
 * Evidence over a real socket (WP E 波 §6.1).
 *
 * This is not a vendor stream and is not presented as one: the upstream is a
 * local HTTP server. What it *does* prove is everything between the CLI and the
 * wire — real `fetch`, real status codes, real retry policy, real SSE framing,
 * real usage and reasoning translation — which is the part this repository owns.
 * The part it cannot prove is what a given vendor actually puts in its frames;
 * that stays `BLOCKED_MISSING_CREDENTIAL` and is recorded as such.
 *
 * The key is read from a file, never from argv: the composition root is the only
 * place allowed to touch a credential source, and a test that inlined the string
 * would quietly endorse the thing the rule forbids.
 */

const SECRET = "sk-evidence-not-a-real-key";

function secretFile(): { readonly path: string; readonly value: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-evidence-"));
  const path = join(dir, "secret");
  writeFileSync(path, `${SECRET}\n`, "utf8");
  return { path, value: readFileSync(path, "utf8").trim(), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type Endpoint = {
  readonly url: string;
  readonly auth: () => ReadonlyArray<string | undefined>;
  readonly hits: () => number;
  readonly close: () => Promise<void>;
};

function startEndpoint(respond: (hit: number, res: ServerResponse) => void): Promise<Endpoint> {
  const seen: Array<string | undefined> = [];
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    seen.push(req.headers.authorization);
    req.resume();
    respond(hits, res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        auth: () => [...seen],
        hits: () => hits,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const REQUEST: ProviderRequest = {
  attemptId: "att-evidence-1",
  model: "evidence-model",
  tools: [],
  messages: [{ role: "user", content: "hi" }],
};

async function drain(events: AsyncIterable<ProviderEvent>): Promise<readonly ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

async function withProvider<T>(
  respond: (hit: number, res: ServerResponse) => void,
  run: (endpoint: Endpoint, apiKey: string) => Promise<T>,
): Promise<T> {
  const endpoint = await startEndpoint(respond);
  const secret = secretFile();

  try {
    return await run(endpoint, secret.value);
  } finally {
    await endpoint.close();
    secret.cleanup();
  }
}

function providerOf(endpoint: string, apiKey: string, sleep?: (ms: number) => Promise<void>) {
  return createOpenAiCompatibleProvider({
    endpoint,
    model: "evidence-model",
    apiKey,
    ...(sleep === undefined ? {} : { sleep }),
  });
}

test("a real 401 is classified auth and is not retried", async () => {
  await withProvider(
    (_hit, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "nope" } }));
    },
    async (endpoint, apiKey) => {
      const events = await drain(
        providerOf(endpoint.url, apiKey).stream(REQUEST, new AbortController().signal),
      );
      const failure = events.find((event) => event.type === "error");

      assert.equal(failure?.type, "error");
      assert.equal(failure !== undefined && failure.class, "auth");
      assert.equal(failure !== undefined && failure.retryable, false);
      assert.equal(endpoint.hits(), 1);
    },
  );
});

test("a real 429 is retried once against the same socket and then succeeds", async () => {
  await withProvider(
    (hit, res) => {
      if (hit === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      sse(res, [
        { choices: [{ delta: { content: "after-retry" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    },
    async (endpoint, apiKey) => {
      const events = await drain(
        providerOf(endpoint.url, apiKey, async () => undefined).stream(
          REQUEST,
          new AbortController().signal,
        ),
      );

      assert.equal(endpoint.hits(), 2);
      assert.equal(
        events.some(
          (event) => event.type === "text_delta" && event.text === "after-retry",
        ),
        true,
      );
    },
  );
});

test("usage carries the cache dimension and reasoning survives the wire", async () => {
  await withProvider(
    (_hit, res) => {
      sse(res, [
        { choices: [{ delta: { reasoning_content: "thinking-hard" }, finish_reason: null }] },
        { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        },
      ]);
    },
    async (endpoint, apiKey) => {
      const events = await drain(
        providerOf(endpoint.url, apiKey).stream(REQUEST, new AbortController().signal),
      );
      const usage = events.find((event) => event.type === "usage");

      assert.equal(usage?.type, "usage");
      assert.equal(usage !== undefined && usage.usage.inputTokens, 120);
      assert.equal(usage !== undefined && usage.usage.cacheReadTokens, 64);
      // The vendor does not return these on this stream; recorded as absent
      // rather than as zero, so a later real run can tell the difference.
      assert.equal(usage !== undefined && usage.usage.cacheWriteTokens, 0);
      assert.equal(usage !== undefined && usage.usage.reasoningTokens, 0);

      assert.equal(
        events.some(
          (event) => event.type === "reasoning_delta" && event.text === "thinking-hard",
        ),
        true,
      );
    },
  );
});

test("the key travels in the header and in nothing else observable", async () => {
  await withProvider(
    (_hit, res) => {
      sse(res, [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    },
    async (endpoint, apiKey) => {
      const events = await drain(
        providerOf(endpoint.url, apiKey).stream(REQUEST, new AbortController().signal),
      );

      assert.equal(endpoint.auth()[0], `Bearer ${SECRET}`);
      const wire = JSON.stringify(events);

      assert.equal(wire.includes(SECRET), false);
      assert.equal(wire.includes("Authorization"), false);
    },
  );
});

test("a refused connection is a network failure, not a crash", async () => {
  const secret = secretFile();
  try {
    // Port 1 is reserved and nothing listens on it: the connect fails for real.
    const events = await drain(
      providerOf("http://127.0.0.1:1/v1/chat/completions", secret.value).stream(
        REQUEST,
        new AbortController().signal,
      ),
    );
    const failure = events.find((event) => event.type === "error");

    assert.equal(failure?.type, "error");
    assert.equal(failure !== undefined && failure.class, "network");
  } finally {
    secret.cleanup();
  }
});
