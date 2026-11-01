import type { JsonObject } from "../../protocol/envelope.js";
import { TRYLO_VERSION } from "../../protocol/version.js";
import {
  DEFAULT_MCP_LIST_TIMEOUT_MS,
  DEFAULT_MCP_PROTOCOL_VERSION,
  type McpCallFailure,
  type McpCallRequest,
  type McpConnectFailure,
  type McpReadResourceRequest,
  type McpResourceFailure,
  type McpResourceListResult,
  type McpResourceReadResult,
  type McpResourceTemplatesResult,
  type McpServerInfo,
  type McpStdioClient,
  type McpToolListFailure,
  type McpToolOutcome,
  type McpToolSpec,
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
import { createStdioTransport, type StdioTransport, type StdioTransportSpec } from "./transport.js";
import {
  crashedOutcome,
  interpretInitialize,
  interpretToolList,
  interpretToolResult,
  splitQualified,
  timeoutOutcome,
} from "./client-interpret.js";
import {
  interpretResourceList,
  interpretResourceRead,
  interpretResourceTemplates,
} from "../../mcp/resources.js";

/**
 * One MCP server, one child process, one connection.
 *
 * The lifecycle is strictly ordered and each step is a precondition of the
 * next, because MCP itself makes it so: `tools/call` before `initialize` is not
 * a slow call, it is an invalid one, and answering it locally is more honest
 * than sending it and guessing at the reply.
 *
 *   created ──connect()──▶ initialized ──listTools()/callTool()──▶ usable
 *      │                       │                                      │
 *      └─────────close()───────┴────────────close()──────────────────┘
 *
 * Three refusals are implemented here rather than left to a caller:
 *
 *  - **Version refusal.** A server that answers `initialize` with a revision
 *    this package does not speak is disconnected before `initialized` is sent.
 *    Half a handshake is worse than none: the server would believe the session
 *    is live.
 *  - **Capability refusal.** `elicitation`, `sampling` and the multi-round-trip
 *    `input_required` result are answered with a JSON-RPC error (or by closing,
 *    when no reply is legal). A single `execute(): Promise<Outcome>` cannot
 *    represent "the tool is now waiting for a human" (D3 §10.11), so pretending
 *    otherwise would either hang a turn or drop a request silently.
 *  - **Tool name refusal.** A tool whose name contains `__` cannot be addressed
 *    unambiguously (see `mcp/names.ts`); it is dropped from the listing so it
 *    can never become callable, and the rest of the server keeps working.
 *
 * `timeoutMs` is required on every call and is finite. A call with no deadline
 * is not something this layer knows how to clean up after.
 *
 * The connection state lives in one {@link ClientState} object and every
 * lifecycle step is a module function over it, so the factory is a table
 * rather than a 200-line closure. Reply *interpretation* is not here at all —
 * it is pure and lives in `client-interpret.ts`.
 */

export type McpClientSpec = {
  readonly serverId: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Bounded diagnostics budget for stderr. */
  readonly maxStderrBytes?: number;
  /** How long the whole handshake may take. */
  readonly handshakeTimeoutMs?: number;
  /** Overridable so a test can point at a revision the server does not know. */
  readonly protocolVersion?: string;
  /** Injection seam for the transport; the default spawns a process. */
  readonly transportFactory?: (spec: StdioTransportSpec) => StdioTransport;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const CLIENT_INFO = { name: "trylo", version: TRYLO_VERSION } as const;

/** Methods the server may not ask this client to perform. */
const UNSUPPORTED_SERVER_METHODS = new Set<string>([
  "elicitation/create",
  "sampling/createMessage",
  "roots/list",
]);

/** The whole mutable state of one connection, in one place. */
type ClientState = {
  readonly spec: McpClientSpec;
  readonly nextId: () => number;
  readonly transportFactory: (spec: StdioTransportSpec) => StdioTransport;
  /** Servers that misuse `__` in a tool name, recorded once for diagnostics. */
  readonly droppedToolNames: string[];
  transport: StdioTransport | undefined;
  serverInfo: McpServerInfo | undefined;
  closed: boolean;
  listCache: ReadonlyArray<McpToolSpec> | undefined;
};

export function createMcpStdioClient(spec: McpClientSpec): McpStdioClient {
  const state: ClientState = {
    spec,
    nextId: createRequestIds(),
    transportFactory: spec.transportFactory ?? createStdioTransport,
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
    stderrDiagnostics: () => clientStderrDiagnostics(state),
  };
}

type OpenFailure<T> = { readonly failure: T } | undefined;

const ensureOpen = <T>(state: ClientState, failure: (detail: string) => T): OpenFailure<T> => {
  if (state.closed) {
    return { failure: failure("closed: the connection has been closed") };
  }
  if (state.transport === undefined) {
    return { failure: failure("not_initialized: connect() has not been called") };
  }
  if (state.transport.exited()) {
    return { failure: failure("child_exited: the server process is gone") };
  }
  return undefined;
};

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
  const activeTransport = state.transportFactory({
    command: state.spec.command,
    args: state.spec.args,
    env: state.spec.env,
    cwd: state.spec.cwd,
    maxStderrBytes: state.spec.maxStderrBytes ?? DEFAULT_STDERR_BYTES,
  });
  state.transport = activeTransport;

  // Server-initiated traffic is wired before the handshake so a capability
  // request that arrives *during* initialize cannot slip through.
  activeTransport.onIncoming((message) => {
    handleIncoming(state, activeTransport, message);
  });

  const requestedVersion = state.spec.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.spec.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  const response = await activeTransport.request(
    requestMessage(state.nextId(), "initialize", {
      protocolVersion: requestedVersion,
      capabilities: { tools: {}, resources: {} },
      clientInfo: CLIENT_INFO,
    }),
    controller.signal,
  );
  clearTimeout(timer);

  const info = interpretInitialize(activeTransport, response, state.spec.serverId);
  if (!info.ok) {
    await closeClient(state);
    return info;
  }

  // Only reachable after a version the server and this client both accept.
  activeTransport.notify(notificationMessage("notifications/initialized"));
  state.serverInfo = info.value;
  return { ok: true, value: info.value };
}

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
  const activeTransport = state.transport as StdioTransport;
  const response = await activeTransport.request(
    requestMessage(state.nextId(), "tools/list", {}),
    undefined,
  );
  const parsed = interpretToolList(activeTransport, response, state.spec.serverId, state.droppedToolNames);
  if (!parsed.ok) {
    return parsed;
  }
  state.listCache = parsed.value;
  return { ok: true, value: state.listCache };
}

type ResolvedCall = { readonly ok: true; readonly tool: McpToolSpec } | McpCallFailure;

const refuseCall = (code: McpCallFailure["code"], detail: string): McpCallFailure => ({ ok: false, code, detail });

/**
 * Everything a call must prove before it is allowed to spend a round trip:
 * the connection is open, the deadline is real, the name belongs to this
 * server, and the server actually published it.
 */
async function resolveCallableTool(state: ClientState, request: McpCallRequest): Promise<ResolvedCall> {
  const notOpen = ensureOpen<McpCallFailure>(state, (detail) => ({ ok: false, code: "not_initialized", detail }));
  if (notOpen !== undefined) {
    return notOpen.failure;
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    // Refused rather than defaulted: an unbounded call is a caller bug that
    // would otherwise be discovered as a hung process.
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
  const activeTransport = state.transport as StdioTransport;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (request.signal !== undefined) {
    if (request.signal.aborted) {
      return { ok: true, outcome: { outcome: "cancelled" } };
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  try {
    const response = await activeTransport.request(
      requestMessage(state.nextId(), "tools/call", {
        name: resolved.tool.serverToolName,
        arguments: request.arguments as JsonObject,
      }),
      controller.signal,
    );
    // A timeout is decided by the clock, not by what the reply says: a
    // response that arrives after the deadline is late, and reporting it as
    // a result would make the deadline advisory.
    if (timedOut) {
      await killChild(activeTransport);
      return { ok: true, outcome: timeoutOutcome() };
    }
    if (request.signal?.aborted === true) {
      return { ok: true, outcome: { outcome: "cancelled" } };
    }
    if (activeTransport.exited()) {
      return { ok: true, outcome: crashedOutcome(activeTransport) };
    }
    const outcome = interpretToolResult(response, activeTransport);
    if (timedOut) {
      await killChild(activeTransport);
      return { ok: true, outcome: timeoutOutcome() };
    }
    return { ok: true, outcome };
  } finally {
    clearTimeout(timer);
    if (request.signal !== undefined) {
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Resource verbs: `resources/list`, `resources/templates/list`, `resources/read`.
 *
 * Resources are listed fresh on every call — unlike tools they are content,
 * and content may change between two reads of the same server. Every verb
 * here carries a finite deadline (lists default to
 * `DEFAULT_MCP_LIST_TIMEOUT_MS`); without one there is nothing to clean up
 * after. The URI travels verbatim; it is never resolved against the
 * workspace, and an empty one is refused before a round trip is spent.
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
  const activeTransport = state.transport as StdioTransport;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);
  try {
    const response = await activeTransport.request(
      requestMessage(state.nextId(), "resources/list", {
        ...(cursor === undefined ? {} : { cursor }),
      }),
      controller.signal,
    );
    // Decided by the clock, not by what the reply says: the transport may
    // settle an aborted request as an error response rather than a rejection,
    // and reporting that as a result would make the deadline advisory.
    if (timedOut) {
      await killChild(activeTransport);
      return { ok: false, code: "timeout", detail: "the server did not answer resources/list before the deadline" };
    }
    return interpretResourceList(response);
  } catch (error) {
    // The only signal armed here is the deadline's own: any other rejection
    // is a bug below, and it propagates exactly like a tool listing's would
    // rather than being relabelled as a timeout.
    if (!timedOut) {
      throw error;
    }
    return { ok: false, code: "timeout", detail: "the server did not answer resources/list before the deadline" };
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
  const deadline = timeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS;
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return { ok: false, code: "invalid_arguments", detail: "timeoutMs must be a finite positive number" };
  }
  const activeTransport = state.transport as StdioTransport;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);
  try {
    const response = await activeTransport.request(
      requestMessage(state.nextId(), "resources/templates/list", {
        ...(cursor === undefined ? {} : { cursor }),
      }),
      controller.signal,
    );
    if (timedOut) {
      await killChild(activeTransport);
      return {
        ok: false,
        code: "timeout",
        detail: "the server did not answer resources/templates/list before the deadline",
      };
    }
    return interpretResourceTemplates(response);
  } catch (error) {
    if (!timedOut) {
      throw error;
    }
    return {
      ok: false,
      code: "timeout",
      detail: "the server did not answer resources/templates/list before the deadline",
    };
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
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    return refuseResource("invalid_arguments", "timeoutMs must be a finite positive number");
  }
  const activeTransport = state.transport as StdioTransport;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (request.signal !== undefined) {
    if (request.signal.aborted) {
      return refuseResource("cancelled", "read cancelled before it was sent");
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  try {
    const response = await activeTransport.request(
      requestMessage(state.nextId(), "resources/read", { uri: request.uri }),
      controller.signal,
    );
    if (timedOut) {
      await killChild(activeTransport);
      return refuseResource("timeout", "the server did not answer resources/read before the deadline");
    }
    if (request.signal?.aborted === true) {
      return refuseResource("cancelled", "read cancelled while waiting for the server");
    }
    if (activeTransport.exited()) {
      return refuseResource("child_crashed", `the server process exited (stderr ${activeTransport.stderrBytes()} bytes)`);
    }
    return interpretResourceRead(response);
  } finally {
    clearTimeout(timer);
    if (request.signal !== undefined) {
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * A caller-requested close. `serverInfo` is dropped because a closed session
 * has no identity worth reporting; the capability-refusal path deliberately
 * keeps it so diagnostics can still name the server that was refused.
 */
async function closeClient(state: ClientState): Promise<void> {
  if (state.closed) {
    return;
  }
  state.closed = true;
  state.listCache = undefined;
  state.serverInfo = undefined;
  if (state.transport !== undefined) {
    await state.transport.terminate();
  }
}

const clientIsConnected = (state: ClientState): boolean =>
  !state.closed && state.transport !== undefined && !state.transport.exited();

const clientStderrDiagnostics = (
  state: ClientState,
): { readonly bytes: number; readonly truncated: boolean } => {
  if (state.transport === undefined) {
    return { bytes: 0, truncated: false };
  }
  return { bytes: state.transport.stderrBytes(), truncated: state.transport.stderrTruncated() };
};

/**
 * Refuses server-initiated capabilities. Called for both requests and
 * notifications; a notification has no id and therefore cannot be answered,
 * so the only honest response to e.g. `notifications/elicitation` is to
 * record it and close.
 */
function handleIncoming(
  state: ClientState,
  activeTransport: StdioTransport,
  message: JsonRpcIncomingRequest | JsonRpcNotification,
): void {
  const isRequest = "id" in message;
  if (UNSUPPORTED_SERVER_METHODS.has(message.method)) {
    if (isRequest) {
      activeTransport.respond(
        errorResponse(message.id, JSON_RPC_METHOD_NOT_FOUND, `unsupported capability: ${message.method}`),
      );
    }
    // The session cannot be trusted to continue: a server that needs
    // elicitation will keep asking, and this client will keep refusing.
    void closeQuietly(state);
    return;
  }
  if (isRequest) {
    // Any other server-initiated request is equally outside this package.
    activeTransport.respond(
      errorResponse(message.id, JSON_RPC_METHOD_NOT_FOUND, `method not supported: ${message.method}`),
    );
  }
}

async function closeQuietly(state: ClientState): Promise<void> {
  if (state.closed) {
    return;
  }
  state.closed = true;
  state.listCache = undefined;
  if (state.transport !== undefined) {
    await state.transport.terminate();
  }
}

async function killChild(activeTransport: StdioTransport): Promise<void> {
  await activeTransport.terminate();
}
