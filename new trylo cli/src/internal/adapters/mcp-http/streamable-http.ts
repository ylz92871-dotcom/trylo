import {
  type JsonRpcId,
  type JsonRpcIncomingRequest,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../../mcp/jsonrpc.js";
import { scanSse } from "./sse.js";
import {
  decodeWireMessage,
  deliveryFailureOf,
  httpStatusFailure,
  isResponse,
  postJson,
  RemoteRequestError,
  type RemoteTransport,
  type RemoteTransportFailure,
  type WireDeps,
  type RemoteWireSpec,
} from "./wire.js";

/**
 * The `http` transport: MCP Streamable HTTP.
 *
 * One endpoint. Every message is a POST; the reply is either the POST response
 * body itself (`application/json`) or a per-request `text/event-stream` that
 * carries the response — and possibly server-initiated traffic — alongside it.
 * The body is consumed to its end: a server that keeps the response open past
 * its own bytes has nothing more this client needs, and a session that wants
 * server-initiated streaming is a session this package does not implement.
 *
 * Failure mapping lives in the code paths below, not in the client: the wire
 * knows whether bytes never left (`unreachable`) or came back wrong
 * (`framing`), and says so.
 */

type StreamableState = {
  readonly deps: WireDeps;
  readonly spec: RemoteWireSpec;
  readonly incoming: Set<(message: JsonRpcIncomingRequest | JsonRpcNotification) => void>;
  readonly failureListeners: Set<(failure: RemoteTransportFailure) => void>;
  failure: RemoteTransportFailure | undefined;
};

export function createStreamableHttpTransport(
  spec: RemoteWireSpec,
  fetchImpl: typeof fetch,
): RemoteTransport {
  const state: StreamableState = {
    deps: {
      fetchImpl,
      onIncoming: (message) => dispatchIncoming(state, message),
      onFailure: (failure) => reportFailure(state, failure),
    },
    spec,
    incoming: new Set(),
    failureListeners: new Set(),
    failure: undefined,
  };
  return {
    request: (message, signal) => requestStreamable(state, message, signal),
    notify: (message) => {
      void notifyStreamable(state, message);
    },
    respond: (response) => {
      // A server-initiated request refused over streamable HTTP goes back as
      // its own POST; there is no return channel to write into.
      void respondStreamable(state, response);
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
    terminate: () => Promise.resolve(),
  };
}

function dispatchIncoming(
  state: StreamableState,
  message: JsonRpcIncomingRequest | JsonRpcNotification,
): void {
  for (const listener of state.incoming) {
    listener(message);
  }
}

function reportFailure(state: StreamableState, failure: RemoteTransportFailure): void {
  if (state.failure === undefined) {
    state.failure = failure;
  }
  for (const listener of state.failureListeners) {
    listener(failure);
  }
}

async function requestStreamable(
  state: StreamableState,
  message: JsonRpcRequest,
  signal?: AbortSignal,
): Promise<JsonRpcResponse> {
  try {
    const posted = await postJson(state.deps, state.spec, message, signal);
    if (posted.status < 200 || posted.status >= 300) {
      const failure = httpStatusFailure(posted.status, "POST");
      reportFailure(state, failure);
      throw new RemoteRequestError(failure);
    }

    if (isEventStream(posted.contentType)) {
      return await consumeEventText(state, message.id, posted.text);
    }

    return decodeWireMessage(posted.text) as JsonRpcResponse;
  } catch (error) {
    if (error instanceof RemoteRequestError && state.failure === undefined) {
      reportFailure(state, error.failure);
    }
    throw error;
  }
}

async function notifyStreamable(state: StreamableState, message: JsonRpcNotification): Promise<void> {
  try {
    const posted = await postJson(state.deps, state.spec, message);
    if (posted.status < 200 || posted.status >= 300) {
      reportFailure(state, { code: "write_failed", detail: `notification POST returned HTTP ${posted.status}` });
    }
  } catch (error) {
    reportFailure(state, deliveryFailureOf("notification", error));
  }
}

async function respondStreamable(state: StreamableState, response: JsonRpcResponse): Promise<void> {
  try {
    const posted = await postJson(state.deps, state.spec, response);
    if (posted.status < 200 || posted.status >= 300) {
      reportFailure(state, { code: "write_failed", detail: `response POST returned HTTP ${posted.status}` });
    }
  } catch (error) {
    reportFailure(state, deliveryFailureOf("response", error));
  }
}

const isEventStream = (contentType: string): boolean => contentType.includes("text/event-stream");

/**
 * Reads one per-request event stream until the response with `id` arrives.
 * Server-initiated traffic seen on the way is dispatched, never swallowed.
 */
async function consumeEventText(
  state: StreamableState,
  id: JsonRpcId,
  text: string,
): Promise<JsonRpcResponse> {
  const { events } = scanSse(text);

  for (const message of decodeEventPayloads(state, events)) {
    if (isResponse(message) && message.id === id) {
      return message;
    }
  }

  throw new RemoteRequestError({
    code: "framing",
    detail: "event stream ended without a response for this request",
  });
}

/** Decodes event payloads and dispatches everything that is not a response. */
function decodeEventPayloads(
  state: StreamableState,
  events: ReadonlyArray<{ readonly event: string; readonly data: string }>,
): ReadonlyArray<JsonRpcResponse> {
  const responses: JsonRpcResponse[] = [];

  for (const event of events) {
    const message = decodeWireMessage(event.data);
    if (isResponse(message)) {
      responses.push(message);
      continue;
    }
    dispatchIncoming(state, message);
  }

  return responses;
}
