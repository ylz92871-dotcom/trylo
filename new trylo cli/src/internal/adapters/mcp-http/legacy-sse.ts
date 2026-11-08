import {
  type JsonRpcId,
  type JsonRpcIncomingRequest,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../../mcp/jsonrpc.js";
import { freshSseOpen, scanSse } from "./sse.js";
import {
  decodeWireMessage,
  deliveryFailureOf,
  httpStatusFailure,
  isResponse,
  postJson,
  RemoteRequestError,
  type RemoteTransport,
  type RemoteTransportFailure,
  type RemoteWireSpec,
  type WireDeps,
} from "./wire.js";

/**
 * The `sse` transport: legacy HTTP + Server-Sent Events (2024-11-05 era).
 *
 * The shape of the conversation is inverted from Streamable HTTP: the client
 * opens one long-lived GET first, the server's first `event: endpoint` names
 * where POSTs go, and every reply comes back *on the stream*, matched by id.
 * Two consequences are load-bearing here:
 *
 *  - the GET stream must be open before the first request is legal, so
 *    `request` awaits the endpoint instead of guessing a POST target;
 *  - the stream ending is the remote server's version of a child process
 *    dying — every pending request fails, and `failure()` reports
 *    `server_gone`.
 */

type SseState = {
  readonly deps: WireDeps;
  readonly spec: RemoteWireSpec;
  readonly pending: Map<JsonRpcId, PendingCall>;
  readonly incoming: Set<(message: JsonRpcIncomingRequest | JsonRpcNotification) => void>;
  readonly failureListeners: Set<(failure: RemoteTransportFailure) => void>;
  readonly controller: AbortController;
  /** Resolves when the endpoint event arrived; rejects if the stream dies first. */
  readonly endpointReady: Promise<string>;
  resolveEndpoint: ((endpoint: string) => void) | undefined;
  rejectEndpoint: ((failure: RemoteTransportFailure) => void) | undefined;
  endpoint: string | undefined;
  failure: RemoteTransportFailure | undefined;
};

/** One in-flight request waiting for its reply on the event stream. */
type PendingCall = {
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly reject: (error: RemoteRequestError) => void;
};

export function createLegacySseTransport(
  spec: RemoteWireSpec,
  fetchImpl: typeof fetch,
): RemoteTransport {
  const controller = new AbortController();
  let resolveEndpoint: ((endpoint: string) => void) | undefined;
  let rejectEndpoint: ((failure: RemoteTransportFailure) => void) | undefined;
  const endpointReady = new Promise<string>((resolve, reject) => {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });
  const state: SseState = {
    deps: {
      fetchImpl,
      onIncoming: (message) => {
        for (const listener of state.incoming) {
          listener(message);
        }
      },
      onFailure: (failure) => {
        reportFailure(state, failure);
      },
    },
    spec,
    pending: new Map(),
    incoming: new Set(),
    failureListeners: new Set(),
    controller,
    endpointReady,
    resolveEndpoint,
    rejectEndpoint,
    endpoint: undefined,
    failure: undefined,
  };

  openEventStream(state);

  return {
    request: (message, signal) => requestSse(state, message, signal),
    notify: (message) => {
      void notifySse(state, message);
    },
    respond: (response) => {
      void respondSse(state, response);
    },
    onIncoming: (listener) => {
      state.incoming.add(listener);
      return () => state.incoming.delete(listener);
    },
    onFailure: (listener) => {
      state.failureListeners.add(listener);
      return () => state.failureListeners.delete(listener);
    },
    failure: () => state.failure,
    terminate: () => {
      controller.abort();
      return Promise.resolve();
    },
  };
}

/** Opens the GET stream and pumps it for the life of the connection. */
function openEventStream(state: SseState): void {
  void (async () => {
    try {
      const response = await state.deps.fetchImpl(state.spec.url, {
        method: "GET",
        headers: {
          ...state.spec.headers,
          accept: "text/event-stream",
        },
        signal: state.controller.signal,
      });
      if (response.status < 200 || response.status >= 300 || response.body === null) {
        throw new RemoteRequestError(httpStatusFailure(response.status, "GET event stream"));
      }

      await pumpEventStream(state, response.body);
    } catch (error) {
      if (error instanceof RemoteRequestError) {
        reportFailure(state, error.failure);
        return;
      }
      // An abort is reported too: swallowing it would leave `endpointReady`
      // pending forever, and a waiter must never outlive the wire's death.
      reportFailure(state, {
        code: "unreachable",
        detail: `GET event stream failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  })();
}

async function pumpEventStream(state: SseState, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  // The open event is threaded across reads: an event whose terminator lands
  // in a later chunk must survive the read boundary.
  let open = freshSseOpen;

  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }

    buffered += decoder.decode(next.value, { stream: true });
    const scanned = scanSse(buffered, open);

    buffered = scanned.rest;
    open = scanned.open;

    for (const event of scanned.events) {
      handleStreamEvent(state, event);
    }
  }

  reportFailure(state, { code: "server_gone", detail: "the event stream closed" });
}

/** One SSE event: either the endpoint announcement or a JSON-RPC message. */
function handleStreamEvent(state: SseState, event: { readonly event: string; readonly data: string }): void {
  if (event.event === "endpoint") {
    if (state.endpoint === undefined) {
      state.endpoint = new URL(event.data, state.spec.url).toString();
      state.resolveEndpoint?.(state.endpoint);
    }
    return;
  }

  const message = decodeWireMessage(event.data);
  if (isResponse(message)) {
    // A response with a null id is one the server could not attribute; it
    // matches no pending request, so it is dropped rather than guessed at.
    if (message.id !== null) {
      const pending = state.pending.get(message.id);
      if (pending !== undefined) {
        state.pending.delete(message.id);
        pending.resolve(message);
      }
    }
    return;
  }

  state.deps.onIncoming(message);
}

async function requestSse(
  state: SseState,
  message: JsonRpcRequest,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  let endpoint: string;

  try {
    endpoint = await state.endpointReady;
  } catch {
    // `reportFailure` latched the real failure before rejecting the promise.
    throw new RemoteRequestError(
      state.failure ?? { code: "server_gone", detail: "the event stream never produced an endpoint" },
    );
  }

  // The pending resolver is armed *before* the POST: the reply travels on the
  // event stream, so it can arrive the moment the server sees the request —
  // before this caller has finished awaiting its own POST. Arming late is how
  // a reply is silently dropped and the request hangs forever.
  const reply = armPending(state, message.id, signal);

  try {
    const posted = await postJson(state.deps, { ...state.spec, url: endpoint }, message, signal);
    if (posted.status < 200 || posted.status >= 300) {
      const failure = httpStatusFailure(posted.status, "POST");
      dropPending(state, message.id);
      reportFailure(state, failure);
      throw new RemoteRequestError(failure);
    }
  } catch (error) {
    dropPending(state, message.id);
    throw error;
  }

  return await reply;
}

/**
 * Arms the pending resolver for one request. The returned promise rejects
 * when the wire fails, the stream dies, or the caller's deadline aborts —
 * never hangs past its own signal.
 */
function armPending(state: SseState, id: JsonRpcId, signal?: AbortSignal): Promise<JsonRpcResponse> {
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const fail = (failure: RemoteTransportFailure): void => {
      reject(new RemoteRequestError(failure));
    };

    if (signal?.aborted === true) {
      fail({ code: "framing", detail: "aborted before the request was sent" });
      return;
    }

    if (state.failure !== undefined) {
      fail(state.failure);
      return;
    }

    let onAbort: (() => void) | undefined;

    if (signal !== undefined) {
      onAbort = () => {
        state.pending.delete(id);
        fail({ code: "framing", detail: "aborted while waiting for the reply on the event stream" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    state.pending.set(id, {
      resolve: (response) => {
        if (onAbort !== undefined) {
          signal?.removeEventListener("abort", onAbort);
        }
        resolve(response);
      },
      reject: (error) => {
        if (onAbort !== undefined) {
          signal?.removeEventListener("abort", onAbort);
        }
        reject(error);
      },
    });
  });
}

/** Cancels a pending entry after the POST itself failed; never throws. */
function dropPending(state: SseState, id: JsonRpcId): void {
  const pending = state.pending.get(id);
  if (pending !== undefined) {
    state.pending.delete(id);
    pending.reject(new RemoteRequestError({ code: "framing", detail: "request abandoned" }));
  }
}

async function notifySse(state: SseState, message: JsonRpcNotification): Promise<void> {
  await postToEndpoint(state, message);
}

async function respondSse(state: SseState, response: JsonRpcResponse): Promise<void> {
  await postToEndpoint(state, response);
}

/** Refusals and notifications share the POST-to-endpoint path. */
async function postToEndpoint(
  state: SseState,
  message: JsonRpcNotification | JsonRpcResponse,
): Promise<void> {
  if (state.endpoint === undefined) {
    return;
  }
  try {
    const posted = await postJson(state.deps, { ...state.spec, url: state.endpoint }, message);
    if (posted.status < 200 || posted.status >= 300) {
      reportFailure(state, {
        code: "write_failed",
        detail: `POST to the endpoint returned HTTP ${posted.status}`,
      });
    }
  } catch (error) {
    // Fire-and-forget surface: the failure is reported, never thrown.
    reportFailure(state, deliveryFailureOf("method" in message ? "notification" : "response", error));
  }
}

function reportFailure(state: SseState, failure: RemoteTransportFailure): void {
  if (state.failure === undefined) {
    state.failure = failure;
    state.rejectEndpoint?.(failure);
  }

  // Every in-flight request fails with the wire failure, never with silence.
  for (const [id, pending] of [...state.pending]) {
    state.pending.delete(id);
    pending.reject(new RemoteRequestError(failure));
  }

  for (const listener of state.failureListeners) {
    listener(failure);
  }
}
