// Trylo Work — Control Plane WebSocket client.
//
// A thin, dependency-free wrapper around `WebSocket` that
// speaks CoWork-OS's JSON-RPC-over-WS protocol. See
// `types.ts` for the frame shapes. The client:
//   - opens a WebSocket to `config.url`
//   - waits for the server's `connect.challenge` event,
//     then sends a `connect` request with the token
//   - correlates responses to requests by `id`
//   - re-emits server events via `on(event, handler)`
//   - auto-reconnects with a configurable delay
//
// Phase 2.5 just needs `workspace.list` + `task.list` + a
// subscription to `task.*` events. We don't yet interpret
// task events into artifact entries; that mapping lands in
// Phase 2.5b (or whoever picks it up next).
//
// The client is pure: no React, no Tauri. The Trylo renderer
// imports it and wires it to a `useState` for the artifacts
// list + a connection-status indicator.

import {
  Events,
  Methods,
  type ControlPlaneClient,
  type ControlPlaneConfig,
  type EventFrame,
  type Frame,
  type RequestFrame,
  type ResponseFrame,
  type ClientStatus,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const PING_INTERVAL_MS = 30_000;
/** M3 closure §11.3 (M3-P1-12): the TOTAL deadline of a
 *  queued request, counted from enqueue — not from the
 *  eventual socket write. A request can never wait
 *  forever for a connection that may never come up. */
const DEFAULT_QUEUE_DEADLINE_MS = 30_000;

/** Internal: a request we sent that's awaiting a response. */
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
}

/** v1.16.5+ (M3 of the P0 lifecycle fix): a request
 *  submitted via `send()` that has not yet been written to
 *  the WebSocket because the socket is not yet OPEN (or the
 *  handshake has not yet completed). Replaces the previous
 *  behaviour, which silently dropped these requests and
 *  surfaced the loss only as a 10s timeout — see CodeX
 *  audit W-RUN-007. */
interface QueuedRequest {
  readonly method: string;
  readonly params: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  /** M3 closure §11.3: total-deadline timer, armed at
   *  enqueue time. Cleared when the request is written
   *  or failed; fired → the request rejects. */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** v1.16.5+ (M5 of the P0 lifecycle fix): a `whenReady()`
 *  caller waiting for the client to reach the "connected"
 *  state. Resolved when the handshake completes; rejected
 *  on close / error / ready-timeout. */
interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function newId(): string {
  // Crypto-quality random ID for request correlation.
  // Falls back to a less ideal but sufficient Math.random
  // path on platforms without crypto.randomUUID.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeParse(text: string): Frame | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (obj && typeof obj === "object" && "type" in obj) {
      return obj as unknown as Frame;
    }
    return null;
  } catch {
    return null;
  }
}

export function createControlPlaneClient(
  config: ControlPlaneConfig,
): ControlPlaneClient {
  const autoReconnect = config.autoReconnect ?? true;
  const reconnectDelay = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const queueDeadlineMs =
    config.queueDeadlineMs ?? DEFAULT_QUEUE_DEADLINE_MS;

  // M3 closure §11.2 (M3-P1-09): an explicit, monotonic
  // generation counter. Every connect() captures its own
  // generation; disconnect() bumps it so ALL in-flight
  // continuations of the old connection (handshake
  // catches, timers, late closes) are permanently
  // invalid. Socket identity alone misses the window
  // where a stale await resumes AFTER the next connect()
  // already replaced the slot.
  let generation = 0;

  let status: ClientStatus = "disconnected";
  const setStatus = (next: ClientStatus, err?: unknown): void => {
    if (status === next) return;
    status = next;
    // v1.16.5+ (M3 + M5): on every transition, drain the
    // send queue (now that the socket is OPEN) and resolve
    // or reject any callers blocked in whenReady(). The
    // order matters: drain before notifying, so a waiter
    // that immediately calls send() lands in an empty
    // queue and is delivered in the same tick.
    if (next === "connected") {
      flushQueue();
    }
    notifyReadyWaiters(next, err);
    try {
      config.onStatus?.(next, err);
    } catch (cbErr) {
      console.error("[ControlPlane] onStatus callback threw:", cbErr);
    }
  };

  // Auth backoff. cowork's Control Plane rate-limits
  // failed `connect` attempts — after 3 misses our IP
  // gets banned for ~4 minutes. We track the ban
  // ourselves so we don't waste the user's wait by
  // hammering the daemon. The block lifts automatically
  // when the ban expires; subsequent failures extend it.
  let authBlockedUntilMs = 0;
  const markAuthBlocked = (): void => {
    authBlockedUntilMs = Date.now() + 5 * 60_000; // 5 min
  };
  const isAuthBlocked = (): boolean => Date.now() < authBlockedUntilMs;

  let ws: WebSocket | null = null;
  const pending = new Map<string, PendingRequest>();
  // v1.16.5+ (M3): requests waiting to be written once the
  // socket reaches OPEN. Drained by flushQueue() in three
  // places: send() (immediate if already OPEN), WS open
  // event, and the connect.success status transition.
  const sendQueue: QueuedRequest[] = [];
  // v1.16.5+ (M5): one-shot resolvers for callers waiting
  // on the next "connected" transition. Drained in
  // notifyReadyWaiters() whenever status changes.
  const readyWaiters: ReadyWaiter[] = [];
  const listeners = new Map<string | "*", Set<(frame: EventFrame) => void>>();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manualClose = false;
  let challengeSeen = false;

  const emit = (frame: EventFrame): void => {
    // Specific listeners
    listeners.get(frame.event)?.forEach((h) => {
      try {
        h(frame);
      } catch (err) {
        console.error(
          `[ControlPlane] listener for ${frame.event} threw:`,
          err,
        );
      }
    });
    // Wildcard listeners
    listeners.get("*")?.forEach((h) => {
      try {
        h(frame);
      } catch (err) {
        console.error("[ControlPlane] wildcard listener threw:", err);
      }
    });
    // Also forward to the catch-all `onEvent` configured
    // by the caller, so they don't have to subscribe.
    try {
      config.onEvent?.(frame);
    } catch (err) {
      console.error("[ControlPlane] onEvent callback threw:", err);
    }
  };

  const startPing = (): void => {
    stopPing();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === ws.OPEN) {
        sendRaw({
          type: "req",
          id: newId(),
          method: Methods.Ping,
        });
      }
    }, PING_INTERVAL_MS);
  };
  const stopPing = (): void => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const failPending = (err: Error): void => {
    pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(err);
    });
    pending.clear();
    // v1.16.5+ (M3): also reject anything still in the
    // queue. The socket is no longer usable; queued calls
    // must surface the failure rather than wait for a
    // reconnect that may not happen.
    while (sendQueue.length > 0) {
      const r = sendQueue.shift();
      if (!r) break;
      clearTimeout(r.timer);
      r.reject(err);
    }
  };

  // v1.16.5+ (M3): write every queued request to the
  // WebSocket, in order. No-op if the socket is not OPEN
  // OR if the handshake has not yet completed (callers
  // should re-trigger on the next status change to
  // "connected"). Each request starts its own 10s timeout
  // only after the actual write, so the effective wait
  // time is end-to-end latency + 10s, not 10s minus
  // whatever the queue blocked for.
  //
  // The status check is critical: doConnect's own
  // `connect` request is the only request that should be
  // written before the handshake completes. If we flushed
  // on OPEN, any caller that queued a request before
  // `connect.success` would see their request sent BEFORE
  // the server knew who the client is, and the server
  // would answer UNAUTHORIZED. The doConnect path uses
  // `sendSystem` (below) to bypass this guard.
  const flushQueue = (): void => {
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (status !== "connected") return;
    while (sendQueue.length > 0) {
      const r = sendQueue.shift();
      if (!r) break;
      // The total deadline was armed at enqueue; the
      // request now gets its own response timeout.
      clearTimeout(r.timer);
      const id = newId();
      const timer = setTimeout(() => {
        pending.delete(id);
        r.reject(
          new Error(
            `[ControlPlane] ${r.method} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
          ),
        );
      }, DEFAULT_TIMEOUT_MS);
      pending.set(id, {
        resolve: r.resolve,
        reject: r.reject,
        timer,
        method: r.method,
      });
      ws.send(
        JSON.stringify({ type: "req", id, method: r.method, params: r.params }),
      );
    }
  };

  // v1.16.5+ (M3): system-level send that bypasses the
  // queue and the status check. Used by the client's own
  // `connect` handshake, which must travel to the server
  // before any user request. Returns a Promise that
  // resolves with the response payload, like `send`.
  // Rejects immediately if the socket is not OPEN — system
  // callers are expected to know the socket is open (they
  // triggered on `connect.challenge` or `open`).
  const sendSystem = <T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (!ws || ws.readyState !== ws.OPEN) {
        reject(
          new Error(`[ControlPlane] ${method} system call before socket open`),
        );
        return;
      }
      const id = newId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `[ControlPlane] ${method} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
          ),
        );
      }, DEFAULT_TIMEOUT_MS);
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });
      ws.send(
        JSON.stringify({ type: "req", id, method, params }),
      );
    });

  // v1.16.5+ (M5): resolve or reject every ready-waiter
  // in order. Called from setStatus on every transition;
  // the waiter itself decides whether `connected` is what
  // it was waiting for.
  //
  // Only "connected" resolves; "error" and "disconnected"
  // reject. Intermediate states ("connecting", "handshaking")
  // are no-ops so a transient status flicker doesn't
  // poison every pending whenReady().
  const notifyReadyWaiters = (
    next: ClientStatus,
    err?: unknown,
  ): void => {
    if (readyWaiters.length === 0) return;
    let resolved = false;
    if (next === "connected") {
      const waiters = readyWaiters.splice(0, readyWaiters.length);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve();
      }
      resolved = true;
    } else if (next === "error" || next === "disconnected") {
      const waiters = readyWaiters.splice(0, readyWaiters.length);
      for (const w of waiters) {
        clearTimeout(w.timer);
        const reason =
          err instanceof Error
            ? err
            : new Error(
                `[ControlPlane] connection lost before ready (status=${next})`,
              );
        w.reject(reason);
      }
      resolved = true;
    }
    // For "connecting" / "handshaking": leave waiters in
    // place. They'll resolve on the next "connected"
    // transition or reject on the next terminal state.
    if (!resolved) {
      // no-op
    }
  };

  const sendRaw = (frame: RequestFrame): void => {
    if (!ws || ws.readyState !== ws.OPEN) {
      console.warn(
        `[ControlPlane] dropping ${frame.method}: socket not open`,
      );
      return;
    }
    ws.send(JSON.stringify(frame));
  };

  const send = <T = unknown>(method: string, params?: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      // v1.16.5+ (M3): enqueue and let flushQueue() decide
      // whether to write now or hold. No longer drops if the
      // socket isn't yet OPEN — the request stays in the
      // queue until the next "connected" transition.
      const req: QueuedRequest = {
        method,
        params,
        resolve: resolve as (v: unknown) => void,
        reject,
        // §11.3 (M3-P1-12): total deadline from ENQUEUE.
        // The recovery path (reconciler task.get) calls
        // send() directly without a whenReady() gate —
        // without this it could pend forever against a
        // daemon that never comes up.
        timer: setTimeout(() => {
          const idx = sendQueue.indexOf(req);
          if (idx >= 0) sendQueue.splice(idx, 1);
          reject(
            new Error(
              `[ControlPlane] ${method} expired after ${queueDeadlineMs}ms waiting for a connection`,
            ),
          );
        }, queueDeadlineMs),
      };
      sendQueue.push(req);
      // §11.3: never queue without connecting. When the
      // link is down, the request itself restarts the
      // connection attempt.
      if (status === "disconnected" || status === "error") {
        connect();
      }
      flushQueue();
    });

  // v1.16.5+ (M5): one-shot promise that resolves when the
  // client reaches the "connected" state (handshake done).
  // If the connection drops before reaching "connected",
  // the promise rejects with the cause. Default timeout
  // matches the per-send timeout; callers that want a
  // different wait can pass a custom value.
  const whenReady = (timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (status === "connected") {
        resolve();
        return;
      }
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        // timer set after push so we can clear it from inside
        // notifyReadyWaiters.
        timer: setTimeout(() => {
          const idx = readyWaiters.indexOf(waiter);
          if (idx >= 0) readyWaiters.splice(idx, 1);
          reject(
            new Error(
              `[ControlPlane] ready timeout after ${timeoutMs}ms (status=${status})`,
            ),
          );
        }, timeoutMs),
      };
      readyWaiters.push(waiter);
    });

  const connect = (): void => {
    if (
      ws &&
      (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN)
    ) {
      return;
    }
    manualClose = false;
    // §11.2: this connection's generation. Every async
    // continuation below re-checks it before writing
    // shared state (M3-P1-09).
    const gen = ++generation;
    setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(config.url);
    } catch (err) {
      setStatus("error", err);
      scheduleReconnect();
      return;
    }
    ws = socket;

    // Generation guard: every handler below is bound to
    // THIS socket instance AND its generation. A handler
    // only mutates client state while `socket` is still
    // the current `ws` and `gen` is still current. A
    // stale socket (replaced by a newer connect() before
    // its close/error event landed, or orphaned by
    // disconnect()) can no longer flip the status of the
    // new generation or schedule reconnects for it.
    const isCurrent = (): boolean => ws === socket && gen === generation;

    socket.addEventListener("open", () => {
      if (!isCurrent()) return;
      setStatus("handshaking");
      // Some daemons send `connect.challenge` first; we
      // wait for it before sending `connect`. If the
      // daemon doesn't require a handshake we time out
      // and proceed anyway.
      challengeSeen = false;
      setTimeout(() => {
        if (!isCurrent()) return;
        if (!challengeSeen && status === "handshaking") {
          void doConnect(gen);
        }
      }, 1500);
    });

    socket.addEventListener("message", (ev: MessageEvent) => {
      if (!isCurrent()) return;
      const text = typeof ev.data === "string" ? ev.data : "";
      const frame = safeParse(text);
      if (!frame) return;

      if (frame.type === "event") {
        const ef = frame as EventFrame;
        if (ef.event === Events.ConnectSuccess) {
          setStatus("connected");
          startPing();
        } else if (ef.event === "connect.challenge") {
          challengeSeen = true;
          void doConnect(gen);
        }
        emit(ef);
        return;
      }

      if (frame.type === "res") {
        const rf = frame as ResponseFrame;
        const p = pending.get(rf.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(rf.id);
        if (rf.ok) {
          p.resolve(rf.payload);
        } else {
          const err = new Error(
            `[ControlPlane] ${p.method} failed: ${rf.error?.message ?? "unknown"} (${rf.error?.code ?? "no-code"})`,
          );
          p.reject(err);
        }
        return;
      }

      // Request frames from server (rare) — ignore for now.
    });

    socket.addEventListener("error", (ev: Event) => {
      if (!isCurrent()) return;
      // Console-debug (not error) so the dev tools console
      // doesn't fill up with retry noise while the user
      // is figuring out their daemon. The real status is
      // surfaced via `onStatus` to the host app.
      console.debug("[ControlPlane] socket error:", ev);
    });

    socket.addEventListener("close", () => {
      if (!isCurrent()) {
        // A replaced or disposed socket closing is a
        // no-op for the live generation: its pending
        // requests were already failed by the new
        // connect() / disconnect() path, and its status
        // transition must not clobber the new socket's.
        return;
      }
      stopPing();
      failPending(new Error("[ControlPlane] connection closed"));
      if (manualClose) {
        setStatus("disconnected");
      } else {
        setStatus("error", new Error("socket closed"));
        scheduleReconnect();
      }
    });
  };

  const doConnect = async (gen: number): Promise<void> => {
    // M3-P1-09: the handshake await can resume LONG after
    // the socket was replaced or disposed (the old
    // promise rejects when failPending drains it). Every
    // shared-state write after the await must re-check
    // the generation — otherwise a stale handshake
    // failure clobbers the NEW connection's status or
    // schedules reconnects for it.
    const isStale = (): boolean => gen !== generation;
    if (isAuthBlocked()) {
      const wait = Math.ceil((authBlockedUntilMs - Date.now()) / 1000);
      setStatus("error", new Error(`auth blocked, retry in ${wait}s`));
      return;
    }
    try {
      // v1.16.5+ (M3): use sendSystem to bypass the queue
      // and the status gate. The connect handshake must
      // travel to the server before any queued user
      // request, otherwise the server answers UNAUTHORIZED.
      await sendSystem(Methods.Connect, { token: config.token ?? null });
    } catch (err) {
      if (isStale()) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ControlPlane] connect handshake failed:", err);
      // Auth failures (UNAUTHORIZED / "banned for Ns") trigger
      // cowork's per-IP rate limiter. Back off hard so we
      // don't keep ourselves banned. Any other error (the
      // socket died mid-handshake, etc.) gets the normal
      // reconnect treatment.
      if (msg.includes("UNAUTHORIZED") || msg.includes("banned")) {
        markAuthBlocked();
        setStatus("error", err);
      } else {
        setStatus("error", err);
        scheduleReconnect();
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (manualClose || !autoReconnect) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
  };

  const disconnect = (): void => {
    manualClose = true;
    // §11.2: disconnect permanently invalidates the
    // current generation — a handshake catch that
    // resumes afterwards finds a stale generation and
    // writes nothing.
    generation += 1;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopPing();
    failPending(new Error("[ControlPlane] disconnected"));
    const closing = ws;
    // Clear the slot BEFORE the close event lands: the
    // generation guard in the close handler then treats
    // the socket as stale and skips its status write.
    ws = null;
    if (closing) {
      try {
        closing.close();
      } catch {
        // ignore
      }
    }
    setStatus("disconnected");
  };

  const on = (
    event: string,
    handler: (frame: EventFrame) => void,
  ): (() => void) => {
    const key = event;
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  };

  return {
    status: () => status,
    connect,
    disconnect,
    send,
    whenReady,
    on,
  };
}
