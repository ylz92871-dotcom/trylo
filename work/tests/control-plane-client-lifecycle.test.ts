// Trylo Work — ControlPlane client lifecycle regressions
// (node:test).
//
// Phase A (2026-08-26) of the M3 stabilization round.
// Regression suite for the `client.whenReady` blocker:
// the App effect used to await whenReady() BEFORE calling
// connect(), a guaranteed 10s timeout. These tests pin
// the client-side contract the fix relies on:
//
//   1. connect() → handshake → whenReady resolves;
//   2. whenReady() without connect() times out (the
//      exact failure mode the App hit — documented so
//      nobody reintroduces the ordering);
//   3. dispose (disconnect) while waiting rejects the
//      waiter immediately — no hang;
//   4. unexpected close → error → auto-reconnect →
//      connected; a whenReady() registered during the
//      reconnect resolves on the new generation;
//   5. a stale socket's late close event cannot clobber
//      the status of the generation that replaced it;
//   6. mount → cleanup → remount: two client instances
//      are fully independent generations;
//   7. sends submitted before the handshake are queued
//      and delivered once connected (M3 send queue);
//   8. a STALE handshake failure (disconnect mid-
//      handshake + immediate reconnect) cannot clobber
//      the new generation (M3 closure §11.2, M3-P1-09);
//   9. a send issued while disconnected restarts the
//      connection and is delivered (§11.3, M3-P1-12);
//  10. queued requests expire at their TOTAL deadline
//      counted from enqueue (§11.3, M3-P1-12);
//  11. an UNAUTHORIZED handshake shows a clear error and
//      NEVER loops silent reconnects (§14.4).
//
// No vitest/jest — a hand-rolled FakeWebSocket stands in
// for the browser global. Runs via `pnpm test` (see
// work/package.json).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createControlPlaneClient } from "../src/control-plane/client.js";
import type { ControlPlaneClient } from "../src/control-plane/types.js";

type Listener = (ev: unknown) => void;

/** Minimal in-memory WebSocket double. The test drives
 *  the server side by calling `open()`, `emitMessage()`,
 *  and `serverClose()`; `close()` (client-initiated)
 *  schedules the close event asynchronously, matching
 *  browser behaviour. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  readonly url: string;
  readonly sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState >= this.CLOSING) return;
    this.readyState = this.CLOSING;
    // Browser semantics: the close event lands later,
    // not synchronously.
    setTimeout(() => {
      this.readyState = this.CLOSED;
      this.fire("close", {});
    }, 0);
  }

  // ---- test-side drivers (server behaviour) ----

  open(): void {
    this.readyState = this.OPEN;
    this.fire("open", {});
  }

  emitMessage(obj: unknown): void {
    this.fire("message", { data: JSON.stringify(obj) });
  }

  /** The daemon went away without our close(). */
  serverClose(): void {
    this.readyState = this.CLOSED;
    this.fire("close", {});
  }

  private fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

const latestSocket = (): FakeWebSocket => {
  const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  assert.ok(s, "expected a FakeWebSocket to have been created");
  return s;
};

/** Pull the id of the last request the client wrote. */
const lastRequestId = (sock: FakeWebSocket): string => {
  const raw = sock.sent[sock.sent.length - 1];
  assert.ok(raw, "expected the client to have sent a request");
  const parsed = JSON.parse(raw) as { id?: string };
  assert.ok(typeof parsed.id === "string");
  return parsed.id;
};

/** Drive a socket through challenge → connect → success. */
function completeHandshake(sock: FakeWebSocket): void {
  sock.open();
  sock.emitMessage({ type: "event", event: "connect.challenge" });
  const id = lastRequestId(sock); // the client's `connect` req
  sock.emitMessage({ type: "res", id, ok: true, payload: {} });
  sock.emitMessage({ type: "event", event: "connect.success" });
}

/** Poll until the client reaches a status, or time out. */
async function waitForStatus(
  client: ControlPlaneClient,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (client.status() !== status) {
    if (Date.now() > deadline) {
      assert.fail(
        `client did not reach "${status}" within ${timeoutMs}ms (now: ${client.status()})`,
      );
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

const tick = (): Promise<void> =>
  new Promise((r) => setTimeout(r, 0));

describe("ControlPlane client lifecycle", () => {
  let clients: ControlPlaneClient[] = [];

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    // Always break down: clears ping/reconnect timers so
    // the test process exits cleanly.
    for (const c of clients) c.disconnect();
    clients = [];
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  function makeClient(overrides?: {
    reconnectDelayMs?: number;
    autoReconnect?: boolean;
  }): ControlPlaneClient {
    const c = createControlPlaneClient({
      url: "ws://127.0.0.1:47821",
      token: "test-token",
      reconnectDelayMs: overrides?.reconnectDelayMs ?? 5,
      autoReconnect: overrides?.autoReconnect ?? true,
    });
    clients.push(c);
    return c;
  }

  it("connect → handshake → whenReady resolves (1)", async () => {
    const client = makeClient();
    client.connect();
    completeHandshake(latestSocket());
    await client.whenReady(1000);
    assert.equal(client.status(), "connected");
  });

  it("whenReady without connect times out — the pre-fix App ordering (2)", async () => {
    const client = makeClient();
    // No client.connect(): nothing starts the handshake,
    // so the waiter can only time out. This is the exact
    // failure the App shipped with ("ready timeout after
    // 10000ms (status=disconnected)") — pinned here so a
    // regression in the App-side ordering has a matching,
    // documented client behaviour.
    await assert.rejects(client.whenReady(40), /ready timeout/);
    assert.equal(client.status(), "disconnected");
  });

  it("dispose while waiting rejects the waiter immediately (3)", async () => {
    const client = makeClient();
    client.connect();
    latestSocket().open(); // stuck mid-handshake
    const waiting = client.whenReady(5000);
    client.disconnect();
    await assert.rejects(waiting, /connection lost/);
    assert.equal(client.status(), "disconnected");
  });

  it("reconnect recovers; whenReady during reconnect resolves (4)", async () => {
    const client = makeClient({ reconnectDelayMs: 5 });
    client.connect();
    completeHandshake(latestSocket());
    await client.whenReady(1000);

    // Daemon dies unexpectedly.
    latestSocket().serverClose();
    await waitForStatus(client, "error");

    // A waiter registered while down must resolve on the
    // new generation, not reject.
    const waiting = client.whenReady(2000);
    await waitForStatus(client, "connecting");
    completeHandshake(latestSocket());
    await waiting;
    assert.equal(client.status(), "connected");
  });

  it("a stale socket's late close cannot clobber the new generation (5)", async () => {
    const client = makeClient();
    client.connect();
    const oldSock = latestSocket();
    completeHandshake(oldSock);
    await client.whenReady(1000);

    // Manual teardown, then an immediate reconnect: the
    // old socket's close event is still in flight when
    // the new generation starts.
    client.disconnect();
    client.connect();
    const newSock = latestSocket();
    assert.notEqual(newSock, oldSock);
    await waitForStatus(client, "connecting");

    // The stale close lands now. It must be a no-op.
    await tick();
    await tick();
    assert.ok(
      client.status() === "connecting" || client.status() === "handshaking",
      `stale close polluted the new generation (status=${client.status()})`,
    );

    // The new generation still completes normally.
    completeHandshake(newSock);
    await client.whenReady(1000);
    assert.equal(client.status(), "connected");
  });

  it("mount → cleanup → remount: independent generations (6)", async () => {
    // Generation 1: full lifecycle, then unmount.
    const first = makeClient();
    first.connect();
    completeHandshake(latestSocket());
    await first.whenReady(1000);
    first.disconnect();
    assert.equal(first.status(), "disconnected");

    // Generation 2 must be unaffected by generation 1.
    const second = makeClient();
    second.connect();
    completeHandshake(latestSocket());
    await second.whenReady(1000);
    assert.equal(second.status(), "connected");
    assert.equal(first.status(), "disconnected");
  });

  it("sends submitted before the handshake are queued, then delivered (7)", async () => {
    const client = makeClient();
    client.connect();
    const sock = latestSocket();
    sock.open(); // handshaking, not yet connected

    const delivered = client.send<{ ok: true }>("task.create", { title: "t" });
    // Nothing beyond the socket-open state yet; the
    // handshake has not completed, so the request must
    // NOT be on the wire.
    assert.equal(sock.sent.length, 0);

    completeHandshake(sock);
    await client.whenReady(1000);
    // flushQueue wrote the queued request on connect.
    assert.ok(sock.sent.length >= 1, "queued request must be flushed");
    const id = lastRequestId(sock);
    sock.emitMessage({ type: "res", id, ok: true, payload: { ok: true } });
    const res = await delivered;
    assert.deepEqual(res, { ok: true });
  });

  it("a stale handshake failure cannot clobber the replacing generation (8, M3-P1-09)", async () => {
    const client = makeClient();
    client.connect();
    const oldSock = latestSocket();
    oldSock.open();
    oldSock.emitMessage({ type: "event", event: "connect.challenge" });
    // Generation 1's `connect` request is now PENDING —
    // its await has not resolved. This is the window the
    // pre-fix client missed: disconnect BEFORE the
    // handshake completes.
    assert.ok(oldSock.sent.length >= 1);

    client.disconnect();
    client.connect();
    const newSock = latestSocket();
    assert.notEqual(newSock, oldSock);
    completeHandshake(newSock);
    await client.whenReady(1000);

    // Let the OLD handshake's reject continuation run
    // (failPending rejected its sendSystem promise during
    // disconnect). It must write NOTHING.
    await tick();
    await tick();
    assert.equal(
      client.status(),
      "connected",
      "a stale handshake failure clobbered the new generation",
    );
    // No rogue reconnect socket for the dead generation.
    assert.equal(FakeWebSocket.instances.length, 2);
  });

  it("a send while disconnected reconnects and delivers (9, §11.3)", async () => {
    const client = makeClient();
    // Never connected — no socket exists yet.
    assert.equal(FakeWebSocket.instances.length, 0);
    const delivered = client.send<{ ok: true }>("task.list", {});
    // §11.3: never queue without connecting — the send
    // itself must have started the connection.
    assert.equal(FakeWebSocket.instances.length, 1);
    completeHandshake(latestSocket());
    await client.whenReady(1000);
    const id = lastRequestId(latestSocket());
    latestSocket().emitMessage({
      type: "res",
      id,
      ok: true,
      payload: { ok: true },
    });
    const res = await delivered;
    assert.deepEqual(res, { ok: true });
  });

  it("auth rejection shows a clear error and never loops silent reconnects (11, §14.4)", async () => {
    const statusLog: Array<{ status: string; message?: string }> = [];
    const client = createControlPlaneClient({
      url: "ws://127.0.0.1:47821",
      token: "wrong-token",
      reconnectDelayMs: 5,
      autoReconnect: true,
      onStatus: (status, err) => {
        statusLog.push({
          status,
          message: err instanceof Error ? err.message : undefined,
        });
      },
    });
    clients.push(client);
    client.connect();
    const sock = latestSocket();
    sock.open();
    sock.emitMessage({ type: "event", event: "connect.challenge" });
    const id = lastRequestId(sock);
    // The daemon rejects the token.
    sock.emitMessage({
      type: "res",
      id,
      ok: false,
      error: { code: 401, message: "UNAUTHORIZED" },
    });
    await waitForStatus(client, "error");

    // 1) The error is VISIBLE and carries the server's
    //    reason — never a silent status flip.
    const errStatus = statusLog.find((s) => s.status === "error");
    assert.ok(errStatus, "expected a visible error transition");
    assert.match(errStatus.message ?? "", /UNAUTHORIZED/);

    // 2) No silent reconnect loop: well past the 5ms
    //    reconnect delay there is still exactly ONE
    //    socket — the auth backoff suppressed the retry.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      FakeWebSocket.instances.length,
      1,
      "auth failure must not loop reconnects",
    );

    // 3) A user-triggered retry inside the backoff window
    //    fails fast with the block reason instead of
    //    hammering the daemon. Drop the dead socket first
    //    (a daemon that rejected auth would not keep us).
    sock.serverClose();
    await waitForStatus(client, "error"); // close → error
    // The close-triggered reconnect lands after the 5ms
    // delay; it must ALSO respect the auth block.
    await new Promise((r) => setTimeout(r, 40));
    const retrySock = latestSocket();
    assert.notEqual(retrySock, sock);
    retrySock.open();
    retrySock.emitMessage({ type: "event", event: "connect.challenge" });
    await waitForStatus(client, "error");
    const blocked = statusLog.filter((s) => s.status === "error").at(-1);
    assert.match(blocked?.message ?? "", /auth blocked/);
    // No `connect` request ever went out on the retry
    // socket — the block short-circuits the handshake.
    assert.equal(retrySock.sent.length, 0);
  });

  it("queued requests expire at their TOTAL deadline (10, §11.3)", async () => {
    const client = createControlPlaneClient({
      url: "ws://127.0.0.1:47821",
      token: "test-token",
      autoReconnect: false,
      queueDeadlineMs: 30,
    });
    clients.push(client);
    client.connect();
    const sock = latestSocket();
    // The socket never opens — the link hangs in
    // CONNECTING. The recovery path (reconciler task.get)
    // used to pend forever here.
    const queued = client.send("task.get", { taskId: "x" });
    await assert.rejects(queued, /expired after 30ms/);

    // The expired item left the queue: completing the
    // handshake later must NOT write it.
    completeHandshake(sock);
    await client.whenReady(1000);
    assert.ok(
      !sock.sent.some((raw) => raw.includes("task.get")),
      "an expired queued request must not be flushed later",
    );
  });
});
