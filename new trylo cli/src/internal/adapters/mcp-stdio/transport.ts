import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonValue } from "../../protocol/envelope.js";
import {
  encodeMessage,
  scanFrames,
  type DecodedMessage,
  type JsonRpcId,
  type JsonRpcIncomingRequest,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../../mcp/jsonrpc.js";
import { childEnvironment } from "./transport-env.js";

/**
 * The one place an MCP child process is created.
 *
 * Everything else in this package decides *whether* a line may be sent; this
 * does the sending. Keeping it separate is what lets the connection tests assert
 * "no process was spawned" by counting, instead of trying to observe a process
 * that never existed.
 *
 * Two deliberate omissions:
 *
 *  - **No shell.** The command is an executable and the arguments are an array.
 *    `shell: true` would turn a registry entry into a shell script, which is a
 *    different and much larger thing than "a program with arguments".
 *  - **No inherited credentials.** The child gets the base environment from
 *    `transport-env.ts` plus whatever the registry entry named explicitly.
 *
 * stdout is a protocol channel and is parsed as JSON-RPC and nothing else.
 * stderr is diagnostics, is kept bounded, and is never interpreted as a
 * result — a server that answers on stderr has not answered.
 *
 * The mutable session state lives in one {@link TransportState} record and each
 * step (spawn, wire, dispatch, settle, terminate) is a module function over it,
 * so the factory is a table of six entries rather than a 250-line closure.
 */

export type StdioTransportSpec = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Bytes of stderr kept for diagnostics before it is dropped. */
  readonly maxStderrBytes: number;
};

export type StdioTransport = {
  /** Sends a request and resolves when its response arrives. */
  request(message: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  /** Fire-and-forget, e.g. `initialized`. */
  notify(message: JsonRpcNotification): void;
  /** Responds to a request the *server* sent (used to refuse capabilities). */
  respond(response: JsonRpcResponse): void;
  /** Server-initiated requests and notifications, in arrival order. */
  onIncoming(listener: (message: JsonRpcIncomingRequest | JsonRpcNotification) => void): () => void;
  /** Fires once when the child exits or the stream fails. */
  onFailure(listener: (failure: StdioTransportFailure) => void): () => void;
  readonly stderrBytes: () => number;
  readonly stderrTruncated: () => boolean;
  readonly exited: () => boolean;
  /** Kills the child if it is still alive. Idempotent. */
  terminate(): Promise<void>;
};

export type StdioTransportFailure = {
  readonly code: "child_exited" | "framing" | "spawn_failed" | "write_failed";
  readonly detail: string;
  readonly exitCode?: number;
};

/** Everything one live connection owns. A transport is this record plus wires. */
type TransportState = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly maxStderrBytes: number;
  readonly pending: Map<JsonRpcId, (response: JsonRpcResponse) => void>;
  readonly abortHandlers: Map<JsonRpcId, () => void>;
  readonly incoming: Set<(message: JsonRpcIncomingRequest | JsonRpcNotification) => void>;
  readonly failureListeners: Set<(failure: StdioTransportFailure) => void>;
  buffer: string;
  stderrBytes: number;
  stderrTruncated: boolean;
  exited: boolean;
  terminated: boolean;
  failure: StdioTransportFailure | undefined;
};

export function createStdioTransport(spec: StdioTransportSpec): StdioTransport {
  let child: ChildProcessWithoutNullStreams;

  try {
    child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: childEnvironment(spec.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    // `spawn` throws synchronously for a few malformed specs (bad cwd, bad
    // env). The caller is told with a synchronous-shaped failure below.
    const detail = error instanceof Error ? error.message : String(error);
    return createFailedTransport("spawn_failed", detail);
  }

  const state: TransportState = {
    child,
    maxStderrBytes: spec.maxStderrBytes,
    pending: new Map(),
    abortHandlers: new Map(),
    incoming: new Set(),
    failureListeners: new Set(),
    buffer: "",
    stderrBytes: 0,
    stderrTruncated: false,
    exited: false,
    terminated: false,
    failure: undefined,
  };

  wireChildEvents(state);

  return {
    request: (message, signal) => sendRequest(state, message, signal),
    notify: (message) => {
      if (!writeFrame(state, encodeMessage(message))) {
        // Fire-and-forget surface: an undeliverable notification is a session
        // failure, reported like every other one, not a lost write.
        emitFailure(state, {
          code: "write_failed",
          detail: "notification could not be written to the server",
        });
      }
    },
    respond: (response) => {
      if (!writeFrame(state, encodeMessage(response))) {
        emitFailure(state, {
          code: "write_failed",
          detail: "response could not be written to the server",
        });
      }
    },
    onIncoming: (listener) => {
      state.incoming.add(listener);
      return () => state.incoming.delete(listener);
    },
    onFailure: (listener) => {
      state.failureListeners.add(listener);
      if (state.failure !== undefined) {
        listener(state.failure);
      }
      return () => state.failureListeners.delete(listener);
    },
    stderrBytes: () => state.stderrBytes,
    stderrTruncated: () => state.stderrTruncated,
    exited: () => state.exited,
    terminate: () => terminateChild(state),
  };
}

function wireChildEvents(state: TransportState): void {
  const { child } = state;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => handleStdoutChunk(state, chunk));
  child.stderr.on("data", (chunk: string) => handleStderrChunk(state, chunk));

  child.on("error", (error) => {
    // A missing binary surfaces here as ENOENT. `spawn` did not throw, so this
    // is the only notification a caller gets.
    const code = (error as { readonly code?: unknown }).code;

    state.exited = true;
    settleAll(state, { code: "child_exited", detail: "child failed to start" });
    emitFailure(state, {
      code: code === "ENOENT" ? "spawn_failed" : "child_exited",
      detail: error.message,
    });
  });

  child.on("exit", (exitCode, signal) => {
    state.exited = true;
    const detail = {
      code: "child_exited" as const,
      detail: `exit ${String(exitCode)} signal ${String(signal)}`,
    };

    settleAll(state, detail);
    emitFailure(state, detail);
  });
}

function handleStdoutChunk(state: TransportState, chunk: string): void {
  state.buffer += chunk;
  const scanned = scanFrames(state.buffer);

  state.buffer = scanned.rest;

  if (scanned.overflowed) {
    emitFailure(state, { code: "framing", detail: "frame exceeded the maximum size" });
  }

  for (const message of scanned.messages) {
    dispatchMessage(state, message);
  }
}

function handleStderrChunk(state: TransportState, chunk: string): void {
  const budget = state.maxStderrBytes - state.stderrBytes;
  if (budget <= 0) {
    state.stderrTruncated = true;
    return;
  }

  const taken = chunk.length > budget ? chunk.slice(0, budget) : chunk;

  state.stderrBytes += taken.length;

  if (taken.length < chunk.length) {
    state.stderrTruncated = true;
  }
}

function emitFailure(state: TransportState, detail: StdioTransportFailure): void {
  if (state.failure !== undefined) {
    return;
  }

  state.failure = detail;

  for (const listener of state.failureListeners) {
    listener(detail);
  }
}

/** Every waiter is told the session is over rather than left to its deadline. */
function settleAll(state: TransportState, detail: StdioTransportFailure): void {
  for (const [id, resolve] of [...state.pending]) {
    state.pending.delete(id);
    // The abort listener is dropped with the entry: the same signal object may
    // already be aborted, and nothing will ever answer this id again.
    state.abortHandlers.delete(id);
    resolve({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: `${detail.code}: ${detail.detail}` },
    });
  }
}

function dispatchMessage(state: TransportState, message: DecodedMessage): void {
  switch (message.kind) {
    case "response": {
      const id = message.response.id;
      if (id === null) {
        // Only reachable for an unattributable error; nothing is waiting.
        return;
      }

      const resolve = state.pending.get(id);
      if (resolve === undefined) {
        return;
      }

      state.pending.delete(id);
      state.abortHandlers.delete(id);
      resolve(message.response);

      return;
    }
    case "request":
    case "notification": {
      const payload = message.kind === "request" ? message.request : message.notification;
      for (const listener of state.incoming) {
        listener(payload);
      }
      return;
    }
    case "invalid": {
      // A single malformed line is not fatal on its own: the response it was
      // supposed to be will never arrive and its waiter will hit its
      // deadline, which is a more accurate report than tearing the session
      // down over one bad line.
      return;
    }
  }
}

function rejectWith(state: TransportState, id: JsonRpcId, detail: string): void {
  const resolve = state.pending.get(id);
  if (resolve === undefined) {
    return;
  }

  state.pending.delete(id);
  state.abortHandlers.delete(id);
  resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: detail } });
}

function writeFrame(state: TransportState, text: string): boolean {
  if (state.exited || state.terminated || state.child.stdin.destroyed) {
    return false;
  }
  try {
    state.child.stdin.write(text);
    return true;
  } catch {
    return false;
  }
}

function sendRequest(
  state: TransportState,
  message: JsonRpcRequest,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  if (state.exited || state.terminated) {
    return Promise.resolve({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "child_exited: the server process is gone" },
    });
  }

  if (signal?.aborted === true) {
    return Promise.resolve({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "aborted: request was cancelled before it was sent" },
    });
  }

  return new Promise<JsonRpcResponse>((resolve) => {
    state.pending.set(message.id, resolve);

    if (signal !== undefined) {
      const onAbort = (): void => {
        rejectWith(state, message.id, "aborted: request was cancelled");
      };
      state.abortHandlers.set(message.id, onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (!writeFrame(state, encodeMessage(message))) {
      rejectWith(state, message.id, "write_failed: could not write to the server");
    }
  });
}

async function terminateChild(state: TransportState): Promise<void> {
  if (state.terminated) {
    return;
  }

  state.terminated = true;

  if (state.exited) {
    return;
  }

  const { child } = state;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    child.once("exit", done);

    try {
      child.stdin.end();
    } catch {
      // The child may already have closed its end.
    }

    try {
      if (!child.kill()) {
        done();
      }
    } catch {
      // kill() throwing (already-dead child, say) settles the wait the same
      // way — and the deadline timer below is the backstop either way.
      done();
    }

    // A child that ignores SIGTERM must not hold the caller forever; the
    // process is detached from this client's interests either way.
    const timer = setTimeout(done, 2_000);

    timer.unref?.();
  });
}

/**
 * A transport that is already dead, for the cases where `spawn` itself fails.
 * Returning one keeps `connect()` a single code path instead of a second
 * pre-flight branch that could drift from the real one.
 */
function createFailedTransport(code: "spawn_failed", detail: string): StdioTransport {
  const failure: StdioTransportFailure = { code, detail };
  return {
    request(message) {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: `${code}: ${detail}` },
      });
    },
    notify() {},
    respond() {},
    onIncoming() {
      return () => {};
    },
    onFailure(listener) {
      listener(failure);
      return () => {};
    },
    stderrBytes: () => 0,
    stderrTruncated: () => false,
    exited: () => true,
    terminate: async () => {},
  };
}

/** Re-exported so the connection module does not need to reach into jsonrpc. */
export type { JsonRpcIncomingRequest, JsonRpcNotification, JsonValue };
