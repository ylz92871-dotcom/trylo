import type { JsonObject } from "../../protocol/envelope.js";
import { executionDeadline } from "../execution-deadline.js";
import { TRYLO_VERSION } from "../../protocol/version.js";
import { createWorkspaceRoots, type McpWorkspaceRoots } from "../../mcp/roots.js";
import type {
  McpCallFailure,
  McpCallRequest,
  McpConnectFailure,
  McpReadResourceRequest,
  McpResourceFailure,
  McpResourceListResult,
  McpResourceReadResult,
  McpResourceTemplatesResult,
  McpServerInfo,
  McpStdioClient,
  McpToolListFailure,
  McpToolOutcome,
  McpToolSpec,
} from "../../ports/mcp-client.js";
import {
  DEFAULT_MCP_LIST_TIMEOUT_MS,
  DEFAULT_MCP_PROTOCOL_VERSION,
} from "../../ports/mcp-client.js";
import {
  JSON_RPC_METHOD_NOT_FOUND,
  createRequestIds,
  errorResponse,
  notificationMessage,
  requestMessage,
  type JsonRpcIncomingRequest,
  type JsonRpcNotification,
} from "../../mcp/jsonrpc.js";
import { splitQualified } from "../mcp-stdio/client-interpret.js";
import { createLegacySseTransport } from "./legacy-sse.js";
import {
  interpretRemoteInitialize,
  interpretRemoteToolList,
  interpretRemoteToolResult,
  remoteCrashedOutcome,
  remoteTimeoutOutcome,
  wireFailureToCall,
  wireFailureToConnect,
  wireFailureToResource,
  wireFailureToToolList,
} from "./interpret-remote.js";
import {
  interpretResourceList,
  interpretResourceRead,
  interpretResourceTemplates,
} from "../../mcp/resources.js";
import { RemoteRequestError, type RemoteTransport, type RemoteWireSpec } from "./wire.js";
import { createStreamableHttpTransport } from "./streamable-http.js";

/**
 * One MCP server, one remote connection, one session.
 *
 * The lifecycle is the stdio client's lifecycle, deliberately: initialize
 * before anything else, tools listed before they are callable, every call
 * honors explicit deadlines and cancellation. The type returned is `McpStdioClient` — the port's
 * *shape* is "one MCP conversation", and only its name says stdio; a remote
 * client that satisfies it can sit behind the same composition root (see
 * `mcp/session.ts`) without a second port.
 *
 * Two refusals carry over from the stdio client:
 *
 *  - **Version refusal.** A server answering `initialize` with an unsupported
 *    revision is disconnected before `initialized` is sent.
 *  - **Capability refusal.** `elicitation`, `sampling` and unconfigured roots
 *    are answered with a JSON-RPC error and the session is closed (D3 §10.11).
 */

export type McpHttpClientSpec = {
  readonly serverId: string;
  /** `"http"` = Streamable HTTP; `"sse"` = legacy HTTP+SSE. */
  readonly transport: "http" | "sse";
  readonly url: string;
  /** Opt-in local workspace disclosure. Remote registry entries do not set this implicitly. */
  readonly workspaceRoot?: string;
  /** Registry `headers`, sent on every request. Values stay client-side. */
  readonly headers?: Readonly<Record<string, string>>;
  /** How long the whole handshake may take. */
  readonly handshakeTimeoutMs?: number;
  /** Overridable so a test can point at a revision the server does not know. */
  readonly protocolVersion?: string;
  /** Injection seam for tests; the default is the platform fetch. */
  readonly fetchImpl?: typeof fetch;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const CLIENT_INFO = { name: "trylo", version: TRYLO_VERSION } as const;

/** Methods the server may not ask this client to perform. */
const UNSUPPORTED_SERVER_METHODS = new Set<string>([
  "elicitation/create",
  "sampling/createMessage",
  "roots/list",
]);

type ClientState = {
  readonly spec: McpHttpClientSpec;
  readonly roots: McpWorkspaceRoots;
  readonly nextId: () => number;
  readonly transportFactory: (spec: RemoteWireSpec) => RemoteTransport;
  readonly droppedToolNames: string[];
  transport: RemoteTransport | undefined;
  serverInfo: McpServerInfo | undefined;
  closed: boolean;
  listCache: ReadonlyArray<McpToolSpec> | undefined;
};

const wireSpecOf = (spec: McpHttpClientSpec): RemoteWireSpec => ({
  url: spec.url,
  headers: spec.headers ?? {},
});

export function createMcpHttpClient(spec: McpHttpClientSpec): McpStdioClient {
  const state: ClientState = {
    spec,
    roots: createWorkspaceRoots(spec.workspaceRoot),
    nextId: createRequestIds(),
    transportFactory: (wire) =>
      spec.transport === "sse" ? createLegacySseTransport(wire, spec.fetchImpl ?? fetch) : createStreamableHttpTransport(wire, spec.fetchImpl ?? fetch),
    droppedToolNames: [],
    transport: undefined,
    serverInfo: undefined,
    closed: false,
    listCache: undefined,
  };
  return {
    connect: () => connectClient(state),
    listTools: () => listClientTools(state),
    callTool: (request) => callClientTool(state, request),
    listResources: (cursor, timeoutMs) => listClientResources(state, cursor, timeoutMs),
    listResourceTemplates: (cursor, timeoutMs) => listClientResourceTemplates(state, cursor, timeoutMs),
    readResource: (request) => readClientResource(state, request),
    close: () => closeClient(state),
    isConnected: () => clientIsConnected(state),
    // A remote transport has no stderr; the diagnostics contract still holds.
    stderrDiagnostics: () => ({ bytes: 0, truncated: false }),
  };
}

const failConnect = (code: McpConnectFailure["code"], detail: string): McpConnectFailure => ({
  ok: false,
  code,
  detail,
});

async function connectClient(
  state: ClientState,
): Promise<{ readonly ok: true; readonly value: McpServerInfo } | McpConnectFailure> {
  // `closed` is terminal, and it wins over the transport check below: after a
  // close the transport reference is kept (so failure attribution still works),
  // and reporting `already_connected` for a *closed* session would be a lie.
  if (state.closed) {
    return failConnect("closed", "closed: the connection has been closed");
  }

  if (state.transport !== undefined) {
    return failConnect("already_connected", "this client already owns a connection");
  }

  const transport = state.transportFactory(wireSpecOf(state.spec));

  state.transport = transport;
  transport.onIncoming((message) => handleIncoming(state, transport, message));

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    state.spec.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );

  try {
    const response = await transport.request(
      requestMessage(state.nextId(), "initialize", {
        protocolVersion: state.spec.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION,
        capabilities: state.roots.capabilities,
        clientInfo: CLIENT_INFO,
      }),
      controller.signal,
    );
    const info = interpretRemoteInitialize(response, state.spec.serverId);
    if (!info.ok) {
      await closeClient(state);
      return info;
    }

    transport.notify(notificationMessage("initialized"));
    state.serverInfo = info.value;

    return { ok: true, value: info.value };
  } catch (error) {
    return await connectFailure(state, error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

/** A handshake that threw: timed out, was refused on the wire, or never left. */
async function connectFailure(
  state: ClientState,
  error: unknown,
  aborted: boolean,
): Promise<McpConnectFailure> {
  await closeClient(state);

  if (aborted) {
    return failConnect("handshake_timeout", "the server did not answer initialize before the deadline");
  }

  if (error instanceof RemoteRequestError) {
    return wireFailureToConnect(error.failure);
  }

  const wireFailure = state.transport?.failure();
  if (wireFailure !== undefined) {
    return wireFailureToConnect(wireFailure);
  }

  return failConnect("framing", `unexpected handshake error: ${error instanceof Error ? error.message : String(error)}`);
}

type OpenFailure<T> = { readonly failure: T } | undefined;

const ensureOpen = <T>(state: ClientState, failure: (detail: string) => T): OpenFailure<T> => {
  if (state.closed) {
    return { failure: failure("closed: the connection has been closed") };
  }

  if (state.transport === undefined) {
    return { failure: failure("not_initialized: connect() has not been called") };
  }

  return undefined;
};

async function listClientTools(
  state: ClientState,
): Promise<{ readonly ok: true; readonly value: ReadonlyArray<McpToolSpec> } | McpToolListFailure> {
  const notOpen = ensureOpen<McpToolListFailure>(state, (detail) => ({ ok: false, code: "not_initialized", detail }));
  if (notOpen !== undefined) {
    return notOpen.failure;
  }

  if (state.listCache !== undefined) {
    return { ok: true, value: state.listCache };
  }

  const transport = state.transport as RemoteTransport;

  try {
    const response = await transport.request(requestMessage(state.nextId(), "tools/list", {}));
    const parsed = interpretRemoteToolList(response, state.spec.serverId, state.droppedToolNames);
    if (!parsed.ok) {
      return parsed;
    }

    state.listCache = parsed.value;

    return { ok: true, value: state.listCache };
  } catch (error) {
    return listFailure(state, error);
  }
}

function listFailure(state: ClientState, error: unknown): McpToolListFailure {
  if (error instanceof RemoteRequestError) {
    return wireFailureToToolList(error.failure);
  }

  const wireFailure = state.transport?.failure();
  if (wireFailure !== undefined) {
    return wireFailureToToolList(wireFailure);
  }

  return { ok: false, code: "framing", detail: `unexpected tools/list error: ${String(error)}` };
}

const refuseCall = (code: McpCallFailure["code"], detail: string): McpCallFailure => ({ ok: false, code, detail });

async function resolveCallableTool(
  state: ClientState,
  request: McpCallRequest,
): Promise<{ readonly ok: true; readonly tool: McpToolSpec } | McpCallFailure> {
  const notOpen = ensureOpen<McpCallFailure>(state, (detail) => ({ ok: false, code: "not_initialized", detail }));
  if (notOpen !== undefined) {
    return notOpen.failure;
  }

  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    return refuseCall("invalid_arguments", "timeoutMs must be a finite positive number");
  }

  const split = splitQualified(request.qualifiedName);
  if (split === undefined || split.serverId !== state.spec.serverId) {
    return refuseCall("unknown_tool", `${request.qualifiedName} does not belong to server ${state.spec.serverId}`);
  }

  const list = await listClientTools(state);
  if (!list.ok) {
    return refuseCall("protocol_error", `tool list unavailable: ${list.detail}`);
  }

  const tool = list.value.find((item) => item.serverToolName === split.serverToolName);
  if (tool === undefined) {
    return refuseCall("unknown_tool", `${split.serverToolName} is not published by this server`);
  }

  return { ok: true, tool };
}

async function callClientTool(
  state: ClientState,
  request: McpCallRequest,
): Promise<{ readonly ok: true; readonly outcome: McpToolOutcome } | McpCallFailure> {
  const resolved = await resolveCallableTool(state, request);
  if (!resolved.ok) {
    return resolved;
  }

  const transport = state.transport as RemoteTransport;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();

  if (request.signal !== undefined) {
    if (request.signal.aborted) {
      return { ok: true, outcome: { outcome: "cancelled" } };
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
  }

  let timedOut = false;
  const timer = executionDeadline(request.timeoutMs, () => {
    timedOut = true;
    controller.abort();
  });

  try {
    const response = await transport.request(
      requestMessage(state.nextId(), "tools/call", {
        name: resolved.tool.serverToolName,
        arguments: request.arguments as JsonObject,
      }),
      controller.signal,
    );

    if (timedOut) {
      return { ok: true, outcome: remoteTimeoutOutcome() };
    }

    if (request.signal?.aborted === true) {
      return { ok: true, outcome: { outcome: "cancelled" } };
    }

    return { ok: true, outcome: interpretRemoteToolResult(response) };
  } catch (error) {
    return await callFailure(state, error, timedOut);
  } finally {
    timer?.cancel();
    if (request.signal !== undefined) {
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function callFailure(
  state: ClientState,
  error: unknown,
  timedOut: boolean,
): Promise<{ readonly ok: true; readonly outcome: McpToolOutcome } | McpCallFailure> {
  if (timedOut) {
    return { ok: true, outcome: remoteTimeoutOutcome() };
  }

  if (error instanceof RemoteRequestError) {
    if (error.failure.code === "server_gone" || error.failure.code === "unreachable") {
      await closeClient(state);
      return { ok: true, outcome: remoteCrashedOutcome(error.failure.detail) };
    }
    return wireFailureToCall(error.failure);
  }

  return refuseCall("framing", `unexpected tools/call error: ${String(error)}`);
}

/**
 * Resource verbs: `resources/list`, `resources/templates/list`, `resources/read`.
 *
 * Listed fresh on every call — resources are content, and content may change
 * between two reads. Every verb here carries a finite deadline (lists default
 * to `DEFAULT_MCP_LIST_TIMEOUT_MS`); an empty URI is refused before a round
 * trip, and the URI travels verbatim. A `401` anywhere on this path is
 * `needs_auth` (see `wire.ts`), with a detail that carries the status and
 * never a header value or a body.
 */
async function listClientResources(
  state: ClientState,
  cursor: string | undefined,
  timeoutMs: number | undefined,
): Promise<{ readonly ok: true; readonly value: McpResourceListResult } | McpResourceFailure> {
  const notOpen = ensureOpen<McpResourceFailure>(state, (detail) => ({ ok: false, code: "not_initialized", detail }));
  if (notOpen !== undefined) {
    return notOpen.failure;
  }

  const deadline = timeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS;
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return { ok: false, code: "invalid_arguments", detail: "timeoutMs must be a finite positive number" };
  }

  const transport = state.transport as RemoteTransport;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);

  try {
    const response = await transport.request(
      requestMessage(state.nextId(), "resources/list", {
        ...(cursor === undefined ? {} : { cursor }),
      }),
      controller.signal,
    );

    if (timedOut) {
      return { ok: false, code: "timeout", detail: "the server did not answer resources/list before the deadline" };
    }

    return interpretResourceList(response);
  } catch (error) {
    if (timedOut) {
      return { ok: false, code: "timeout", detail: "the server did not answer resources/list before the deadline" };
    }
    return resourceFailure(state, error);
  } finally {
    clearTimeout(timer);
  }
}

async function listClientResourceTemplates(
  state: ClientState,
  cursor: string | undefined,
  timeoutMs: number | undefined,
): Promise<{ readonly ok: true; readonly value: McpResourceTemplatesResult } | McpResourceFailure> {
  const notOpen = ensureOpen<McpResourceFailure>(state, (detail) => ({ ok: false, code: "not_initialized", detail }));
  if (notOpen !== undefined) {
    return notOpen.failure;
  }

  const transport = state.transport as RemoteTransport;
  const deadline = timeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS;
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return { ok: false, code: "invalid_arguments", detail: "timeoutMs must be a finite positive number" };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);

  try {
    const response = await transport.request(
      requestMessage(state.nextId(), "resources/templates/list", {
        ...(cursor === undefined ? {} : { cursor }),
      }),
      controller.signal,
    );

    if (timedOut) {
      return {
        ok: false,
        code: "timeout",
        detail: "the server did not answer resources/templates/list before the deadline",
      };
    }

    return interpretResourceTemplates(response);
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        code: "timeout",
        detail: "the server did not answer resources/templates/list before the deadline",
      };
    }
    return resourceFailure(state, error);
  } finally {
    clearTimeout(timer);
  }
}

const refuseResource = (code: McpResourceFailure["code"], detail: string): McpResourceFailure => ({
  ok: false,
  code,
  detail,
});

async function readClientResource(
  state: ClientState,
  request: McpReadResourceRequest,
): Promise<{ readonly ok: true; readonly value: McpResourceReadResult } | McpResourceFailure> {
  const notOpen = ensureOpen<McpResourceFailure>(state, (detail) => ({ ok: false, code: "not_initialized", detail }));
  if (notOpen !== undefined) {
    return notOpen.failure;
  }

  if (request.uri.length === 0) {
    return refuseResource("invalid_arguments", "uri must be a non-empty string");
  }

  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    return refuseResource("invalid_arguments", "timeoutMs must be a finite positive number");
  }

  const transport = state.transport as RemoteTransport;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();

  if (request.signal !== undefined) {
    if (request.signal.aborted) {
      return refuseResource("cancelled", "read cancelled before it was sent");
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
  }

  let timedOut = false;
  const timer = executionDeadline(request.timeoutMs, () => {
    timedOut = true;
    controller.abort();
  });

  try {
    const response = await transport.request(
      requestMessage(state.nextId(), "resources/read", { uri: request.uri }),
      controller.signal,
    );

    if (timedOut) {
      return refuseResource("timeout", "the server did not answer resources/read before the deadline");
    }

    if (request.signal?.aborted === true) {
      return refuseResource("cancelled", "read cancelled while waiting for the server");
    }

    return interpretResourceRead(response);
  } catch (error) {
    if (timedOut) {
      return refuseResource("timeout", "the server did not answer resources/read before the deadline");
    }

    if (request.signal?.aborted === true) {
      return refuseResource("cancelled", "read cancelled while waiting for the server");
    }

    return resourceFailure(state, error);
  } finally {
    timer?.cancel();
    if (request.signal !== undefined) {
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

function resourceFailure(state: ClientState, error: unknown): McpResourceFailure {
  if (error instanceof RemoteRequestError) {
    return wireFailureToResource(error.failure);
  }

  const wireFailure = state.transport?.failure();
  if (wireFailure !== undefined) {
    return wireFailureToResource(wireFailure);
  }

  return { ok: false, code: "framing", detail: `unexpected resources error: ${String(error)}` };
}

async function closeClient(state: ClientState): Promise<void> {
  if (state.closed) {
    return;
  }

  state.closed = true;
  state.listCache = undefined;
  state.serverInfo = undefined;
  state.transport?.terminate();
}

const clientIsConnected = (state: ClientState): boolean =>
  !state.closed && state.transport !== undefined && state.transport.failure() === undefined;

/**
 * Refuses server-initiated capabilities, exactly like the stdio client: an
 * unsupported request gets a JSON-RPC error and the session closes, because a
 * server that needs elicitation will keep asking.
 */
function handleIncoming(
  state: ClientState,
  transport: RemoteTransport,
  message: JsonRpcIncomingRequest | JsonRpcNotification,
): void {
  const isRequest = "id" in message;

  if (isRequest && message.method === "roots/list" && state.roots.list !== undefined) {
    transport.respond({ jsonrpc: "2.0", id: message.id, result: state.roots.list });
    return;
  }

  if (UNSUPPORTED_SERVER_METHODS.has(message.method)) {
    if (isRequest) {
      transport.respond(
        errorResponse(message.id, JSON_RPC_METHOD_NOT_FOUND, `unsupported capability: ${message.method}`),
      );
    }

    void closeClient(state);

    return;
  }

  if (isRequest) {
    transport.respond(
      errorResponse(message.id, JSON_RPC_METHOD_NOT_FOUND, `method not supported: ${message.method}`),
    );
  }
}
