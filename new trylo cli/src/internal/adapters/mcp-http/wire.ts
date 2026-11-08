import type { JsonValue } from "../../protocol/envelope.js";
import {
  decodeMessage,
  type JsonRpcIncomingRequest,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../../mcp/jsonrpc.js";

/**
 * Shared wire plumbing for the two remote MCP transports (`http` / `sse`).
 *
 * Both speak the same JSON-RPC over the same POST shape; they differ only in
 * where the reply comes from (the POST response body itself, or a long-lived
 * GET event stream). Everything both need — the transport interface, the
 * failure vocabulary, the POST helper, the incoming-message dispatch — lives
 * here so the two transports cannot drift into two dialects.
 */

/**
 * How a remote wire fails. Mapped to client-level failure codes in
 * `client.ts`; kept coarse because the client, not the wire, decides what a
 * failure means for the lifecycle.
 */
export type RemoteTransportFailureCode =
  | "unreachable"
  | "rejected"
  | "framing"
  | "server_gone"
  | "write_failed"
  | "needs_auth";

export type RemoteTransportFailure = {
  readonly code: RemoteTransportFailureCode;
  readonly detail: string;
};

/** Same surface as `StdioTransport`, minus everything a process owns. */
export type RemoteTransport = {
  request(message: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  /** Fire-and-forget, e.g. `initialized`. */
  notify(message: JsonRpcNotification): void;
  /** Refuses a request the *server* sent (capability refusals). */
  respond(response: JsonRpcResponse): void;
  /** Server-initiated requests and notifications, in arrival order. */
  onIncoming(listener: (message: JsonRpcIncomingRequest | JsonRpcNotification) => void): () => void;
  onFailure(listener: (failure: RemoteTransportFailure) => void): () => void;
  /** The first failure this wire hit, or `undefined` while it is healthy. */
  readonly failure: () => RemoteTransportFailure | undefined;
  terminate(): Promise<void>;
};

export type RemoteWireSpec = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

/** Error carrier so `request` can reject with the failure, not a bare string. */
export class RemoteRequestError extends Error {
  readonly failure: RemoteTransportFailure;

  constructor(failure: RemoteTransportFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

export type WireDeps = {
  readonly fetchImpl: typeof fetch;
  readonly onIncoming: (message: JsonRpcIncomingRequest | JsonRpcNotification) => void;
  readonly onFailure: (failure: RemoteTransportFailure) => void;
};

/** Headers every remote POST carries, on top of the user's registry headers. */
export function wireHeaders(spec: RemoteWireSpec): Record<string, string> {
  return {
    ...spec.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

/**
 * One HTTP status mapped to the wire failure vocabulary, stated once.
 *
 * A `401` is the server asking for authentication — a recoverable fact with
 * its own code (`needs_auth`), not a generic refusal: the caller can ask the
 * user to re-authenticate and retry, where a `rejected` can only be reported.
 * A `403` stays `rejected` (forbidden is not unauthenticated). The detail
 * carries the status only, never a header value or a body: a 401 body may
 * quote back a token, and a listing is the most likely thing to be pasted
 * into a bug report.
 */
export function httpStatusFailure(status: number, what: string): RemoteTransportFailure {
  if (status === 401) {
    return { code: "needs_auth", detail: `${what} returned HTTP 401: authentication required` };
  }
  return { code: "rejected", detail: `${what} returned HTTP ${status}` };
}

/**
 * One POST of a JSON-RPC message. Never throws a bare error: a network
 * failure becomes `unreachable`, so the caller has one failure vocabulary.
 * The body read belongs to the same contract — a connection that drops
 * mid-body is as much a network failure as one that never opened.
 */
export async function postJson(
  deps: WireDeps,
  spec: RemoteWireSpec,
  message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
  signal?: AbortSignal,
): Promise<{ readonly status: number; readonly contentType: string; readonly text: string }> {
  let response: Response;
  let text: string;

  try {
    response = await deps.fetchImpl(spec.url, {
      method: "POST",
      headers: wireHeaders(spec),
      body: JSON.stringify(message),
      ...(signal === undefined ? {} : { signal }),
    });
    text = await response.text();
  } catch (error) {
    throw new RemoteRequestError({
      code: "unreachable",
      detail: `POST to ${spec.url} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text };
}

/**
 * The failure a notification or a response reports when its POST fails.
 *
 * `notify` and `respond` are fire-and-forget on the transport interface
 * (`(): void`), so an exception escaping them is an unhandled rejection, not a
 * signal: every delivery failure — typed or unexpected — must land in the
 * `onFailure` channel the client polls instead. `postJson` is contractually
 * never a bare error, so the unexpected branch is a bug guard, and reporting
 * it as `write_failed` with the original message keeps it visible.
 */
export function deliveryFailureOf(kind: "notification" | "response", error: unknown): RemoteTransportFailure {
  if (error instanceof RemoteRequestError) {
    return error.failure;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { code: "write_failed", detail: `${kind} could not be delivered: ${detail}` };
}

/**
 * Decodes one SSE payload or JSON body into a wire message. Anything that is
 * not a well-formed JSON-RPC message is a `framing` failure, not garbage to
 * be guessed at.
 */
export function decodeWireMessage(text: string): JsonRpcResponse | JsonRpcIncomingRequest | JsonRpcNotification {
  let parsed: JsonValue;

  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    throw new RemoteRequestError({ code: "framing", detail: "response body is not valid JSON" });
  }

  const decoded = decodeMessage(parsed);
  if (decoded.kind === "invalid") {
    throw new RemoteRequestError({ code: "framing", detail: decoded.detail });
  }

  if (decoded.kind === "response") {
    return decoded.response;
  }

  if (decoded.kind === "request") {
    return decoded.request;
  }

  return decoded.notification;
}

export function isResponse(
  message: JsonRpcResponse | JsonRpcIncomingRequest | JsonRpcNotification,
): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}
