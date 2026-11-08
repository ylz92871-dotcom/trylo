import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { errorResponse, notificationMessage, requestMessage, type JsonRpcResponse } from "../../mcp/jsonrpc.js";
import { createLegacySseTransport } from "./legacy-sse.js";
import { createStreamableHttpTransport } from "./streamable-http.js";
import { deliveryFailureOf, postJson, RemoteRequestError, type RemoteTransportFailure } from "./wire.js";

/**
 * Delivery failures on the fire-and-forget surfaces (`notify`, `respond`).
 *
 * The transport interface returns `void` for both, so there is nobody left to
 * catch a throw: every delivery failure must land in `onFailure` and
 * `failure()`, which the client polls. A failure that only throws would be an
 * unhandled rejection; one that only returns would leave the server waiting
 * for a reply that was dropped on the floor.
 */

/** A response whose body read fails the way a dropped connection does. */
function fetchWhoseBodyDrops(): typeof fetch {
  return (async () => ({
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    text: () => Promise.reject(new Error("connection reset mid-body")),
  })) as unknown as typeof fetch;
}

test("deliveryFailureOf keeps a typed failure and reports an unexpected error", () => {
  const typed = new RemoteRequestError({ code: "unreachable", detail: "socket gone" });
  assert.deepEqual(deliveryFailureOf("notification", typed), { code: "unreachable", detail: "socket gone" });
  const unexpected = deliveryFailureOf("response", new Error("a bug"));
  assert.equal(unexpected.code, "write_failed");
  assert.match(unexpected.detail, /response could not be delivered: a bug/);
});

test("a body read that drops mid-response is an unreachable failure, not a bare error", async () => {
  await assert.rejects(
    postJson(
      { fetchImpl: fetchWhoseBodyDrops(), onIncoming: () => {}, onFailure: () => {} },
      { url: "https://example.test/mcp", headers: {} },
      notificationMessage("initialized"),
    ),
    (error: unknown) => error instanceof RemoteRequestError && error.failure.code === "unreachable",
  );
});

test("a response whose body cannot be read is reported, not swallowed", async () => {
  const transport = createStreamableHttpTransport({ url: "https://example.test/mcp", headers: {} }, fetchWhoseBodyDrops());
  const failures: RemoteTransportFailure[] = [];

  transport.onFailure((failure) => failures.push(failure));
  transport.respond(errorResponse(1, -32601, "method not found"));
  await until(() => failures.length > 0);
  assert.equal(failures[0]?.code, "unreachable");
  assert.equal(transport.failure()?.code, "unreachable");
});

/** Serves every POST with the given status; no JSON-RPC behaviour at all. */
async function startRefusingServer(status: number): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      await readBody(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    })();
  });

  await listen(server);
  const address = server.address() as AddressInfo;

  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

test("streamable notify and respond report a refused POST as write_failed", async () => {
  const { server, url } = await startRefusingServer(500);
  try {
    const transport = createStreamableHttpTransport({ url, headers: {} }, fetch);
    const failures: RemoteTransportFailure[] = [];

    transport.onFailure((failure) => failures.push(failure));
    transport.notify(notificationMessage("initialized"));
    await until(() => failures.length > 0);
    transport.respond(errorResponse(1, -32601, "method not found"));
    await until(() => failures.length > 1);
    assert.ok(failures.every((failure) => failure.code === "write_failed"));
    assert.equal(transport.failure()?.code, "write_failed");
  } finally {
    await closeServer(server);
  }
});

/**
 * Legacy SSE server: the GET stream announces the endpoint and carries the
 * handshake reply; every POST is refused, which is what the deliveries below
 * have to survive without a throw.
 */
async function startRefusingSseServer(): Promise<{ readonly server: Server; readonly url: string }> {
  let stream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /message\n\n");
        stream = res;
        return;
      }

      const body = JSON.parse(await readBody(req)) as { method?: string; id?: number | string };
      if (body.method === "initialize") {
        // The handshake reply travels on the stream and the POST itself is a
        // plain acknowledgment; the deliveries after it are what get refused.
        stream?.write(`event: message\ndata: ${JSON.stringify({ id: body.id, result: {}, jsonrpc: "2.0" })}\n\n`);
        res.writeHead(202, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    })();
  });

  await listen(server);
  const address = server.address() as AddressInfo;

  return { server, url: `http://127.0.0.1:${address.port}/sse` };
}

test("legacy SSE notify and respond report a refused POST as write_failed", async () => {
  const { server, url } = await startRefusingSseServer();
  try {
    const transport = createLegacySseTransport({ url, headers: {} }, fetch);
    const failures: RemoteTransportFailure[] = [];

    transport.onFailure((failure) => failures.push(failure));
    // The initialize request awaits the endpoint event, so both deliveries
    // below happen with a POST target in hand. Bounded the same way the rest
    // of this file is: a reply that never arrives must fail, not hang.
    const reply = await Promise.race([
      transport.request(requestMessage(1, "initialize")),
      rejectAfter<JsonRpcResponse>(2_000, "the initialize reply never arrived on the stream"),
    ]);

    assert.equal(reply.jsonrpc, "2.0");
    transport.notify(notificationMessage("initialized"));
    await until(() => failures.length > 0);
    transport.respond(errorResponse(2, -32601, "method not found"));
    await until(() => failures.length > 1);
    assert.ok(failures.every((failure) => failure.code === "write_failed"));
    assert.equal(transport.failure()?.code, "write_failed");
  } finally {
    await closeServer(server);
  }
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
  });
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

/** Bounded poll: the transports deliver asynchronously, the sockets do not hang. */
async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail("timed out waiting for the delivery failure to be reported");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rejectAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
