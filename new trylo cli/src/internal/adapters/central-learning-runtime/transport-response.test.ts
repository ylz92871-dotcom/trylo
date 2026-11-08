import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { requestCentralRuntime } from "./transport.js";

test("a response truncated after headers settles a typed transport failure", { timeout: 5000 }, async () => {
  const sockets = new Set<Socket>(), cancellation = new AbortController();
  let truncated!: () => void;
  const connectionClosed = new Promise<void>(resolve => { truncated = resolve; });
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "128" });
    response.flushHeaders();
    response.write('{"ok":', () => {
      setImmediate(() => {
        response.once("close", truncated);
        response.destroy();
      });
    });
  });

  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const pending = requestCentralRuntime({ schemaVersion: 1, scopeKey: "response-scope", ownerId: "response-owner",
      pid: process.pid, port: address.port, token: "local-test-token" }, { operation: "status" }, cancellation.signal)
      .then(reply => ({ kind: "reply" as const, reply }));

    await connectionClosed;
    const terminal = await Promise.race([pending, new Promise<{ kind: "missing" }>(resolve => {
      deadline = setTimeout(() => { resolve({ kind: "missing" }); }, 1000);
    })]);

    assert.ok(terminal.kind === "reply", "the closed response must settle a typed reply; the RPC Promise remained pending");
    assert.equal(terminal.reply.ok, false);

    if (!terminal.reply.ok) assert.equal(typeof terminal.reply.reason, "string");
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    cancellation.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error);else resolve(); }); });
  }
});
