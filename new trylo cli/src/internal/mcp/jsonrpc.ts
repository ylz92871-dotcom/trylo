import type { JsonObject, JsonValue } from "../protocol/envelope.js";

/**
 * JSON-RPC 2.0 framing over a child process's stdio.
 *
 * The MCP stdio transport allows either a `Content-Length`-prefixed framing
 * (borrowed from LSP) or newline-delimited JSON. A client that accepts both is
 * a client with two parsers and twice the failure surface, so this package
 * picks **NDJSON and only NDJSON** and says so. A server that speaks
 * `Content-Length` is not silently mis-parsed as garbage; the very first byte
 * fails to be a JSON value and the connection reports `framing`.
 *
 * Why NDJSON: this package's messages are small control messages, and JSON
 * cannot contain a raw newline inside a string unless it is escaped, so a
 * newline is a genuine frame boundary rather than a heuristic. That is what
 * makes `scanFrames` total: it either finds a complete line or it does not.
 *
 * The decoder is written as a pure incremental state machine — bytes in,
 * frames out — so every hostile-input case (half a frame, two frames in one
 * chunk, an oversized line, invalid UTF-8, a bare newline run) can be tested
 * without a process. The adapter is what attaches it to a stream.
 */

/** JSON-RPC error codes this package generates, plus the ones it interprets. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: JsonValue;
};

export type JsonRpcSuccess = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: JsonValue;
};

export type JsonRpcErrorObject = {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
};

export type JsonRpcErrorResponse = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorObject;
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

/** A request *from* the server. Only used to refuse unsupported capabilities. */
export type JsonRpcIncomingRequest = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: JsonValue;
};

export type JsonRpcNotification = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: JsonValue;
};

export type DecodedMessage =
  | { readonly kind: "response"; readonly response: JsonRpcResponse }
  | { readonly kind: "request"; readonly request: JsonRpcIncomingRequest }
  | { readonly kind: "notification"; readonly notification: JsonRpcNotification }
  | { readonly kind: "invalid"; readonly detail: string };

export type FrameScanResult = {
  /** Messages recovered from the buffer, in arrival order. */
  readonly messages: ReadonlyArray<DecodedMessage>;
  /** Bytes carried over to the next chunk: at most one partial line. */
  readonly rest: string;
  /** True when a single line exceeded the limit and was discarded. */
  readonly overflowed: boolean;
};

/**
 * Upper bound on one frame. The largest legitimate message this package sends
 * or expects is a tool schema, and 8 MiB is far beyond any real one while still
 * finite. A line that crosses it is discarded rather than buffered: growing a
 * string without a ceiling is how a child process turns into a memory attack.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Classifies one parsed JSON value.
 *
 * A `jsonrpc` field other than `"2.0"` is invalid rather than "probably fine":
 * the version is what distinguishes a JSON-RPC peer from a process printing
 * JSON for its own reasons, and every downstream assumption rests on it.
 *
 * The two shape families are decoded by their own function: a message carrying
 * a string `method` is a call (request or notification), anything else is
 * judged as a response.
 */
export function decodeMessage(value: JsonValue): DecodedMessage {
  if (!isRecord(value)) {
    return { kind: "invalid", detail: "message is not an object" };
  }

  if (value["jsonrpc"] !== "2.0") {
    return { kind: "invalid", detail: "missing or unsupported jsonrpc version" };
  }

  if (typeof value["method"] === "string") {
    return decodeCallMessage(value);
  }

  return decodeResponseMessage(value);
}

/** A call from the server: a valid id makes it a request, no id a notification. */
function decodeCallMessage(value: Readonly<Record<string, unknown>>): DecodedMessage {
  // The caller has already checked `typeof value["method"] === "string"`.
  const method = value["method"] as string;
  const id = value["id"];
  const params = value["params"] as JsonValue | undefined;

  if (hasValidId(id)) {
    return {
      kind: "request",
      request: {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      },
    };
  }

  if (id !== undefined) {
    return { kind: "invalid", detail: "request has a malformed id" };
  }

  return {
    kind: "notification",
    notification: { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
  };
}

function decodeResponseMessage(value: Readonly<Record<string, unknown>>): DecodedMessage {
  const id = value["id"];
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");

  // A response must carry an id, and an id of null is only legal for an error
  // the server could not attribute to a request.
  if (!hasValidId(id) && id !== null) {
    return { kind: "invalid", detail: "response has a malformed id" };
  }

  if (hasError && hasResult) {
    return { kind: "invalid", detail: "response has both result and error" };
  }

  if (hasError) {
    const error = value["error"];
    if (!isRecord(error) || typeof error["code"] !== "number" || typeof error["message"] !== "string") {
      return { kind: "invalid", detail: "error object is malformed" };
    }

    const data = error["data"] as JsonValue | undefined;

    return {
      kind: "response",
      response: {
        jsonrpc: "2.0",
        id: (id ?? null) as JsonRpcId | null,
        error: {
          code: error["code"],
          message: error["message"],
          ...(data === undefined ? {} : { data }),
        },
      },
    };
  }

  if (hasResult) {
    if (!hasValidId(id)) {
      return { kind: "invalid", detail: "successful response has no id" };
    }
    return { kind: "response", response: { jsonrpc: "2.0", id, result: value["result"] as JsonValue } };
  }

  return { kind: "invalid", detail: "message is neither request, notification nor response" };
}

/**
 * Pulls every complete frame out of a growing buffer.
 *
 * `\r\n` and `\n` both terminate a frame — a server on Windows writing text
 * mode is not a protocol violation. A trailing `\r` is stripped only at a line
 * end, so a `\r` inside a JSON string survives.
 */
export function scanFrames(buffer: string, maxFrameBytes = MAX_FRAME_BYTES): FrameScanResult {
  const messages: DecodedMessage[] = [];
  let rest = buffer;
  let overflowed = false;

  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline === -1) {
      if (rest.length > maxFrameBytes) {
        // No newline in sight and the buffer is already past the limit: the
        // "frame" cannot be a frame. Drop it and keep scanning from empty.
        overflowed = true;
        rest = "";
      }
      break;
    }

    let line = rest.slice(0, newline);

    rest = rest.slice(newline + 1);

    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (line.trim().length === 0) {
      // Blank keep-alive lines are tolerated and produce nothing.
      continue;
    }

    if (line.length > maxFrameBytes) {
      overflowed = true;
      continue;
    }

    let parsed: JsonValue;

    try {
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      messages.push({ kind: "invalid", detail: "line is not valid JSON" });
      continue;
    }

    messages.push(decodeMessage(parsed));
  }

  return { messages, rest, overflowed };
}

/** Serialises one message for the wire, always exactly one line. */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

export function requestMessage(id: JsonRpcId, method: string, params?: JsonValue): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

export function notificationMessage(method: string, params?: JsonValue): JsonRpcNotification {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A monotonically increasing id source. Never reused within a session. */
export function createRequestIds(): () => number {
  let next = 1;
  return () => next++;
}

/** Narrow helper for reading `params` as an object when a shape needs it. */
export function paramsAsObject(params: JsonValue | undefined): JsonObject | undefined {
  return isRecord(params) ? (params as JsonObject) : undefined;
}
