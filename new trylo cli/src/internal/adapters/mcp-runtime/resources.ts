import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { cancelToolPorts } from "../../ports/tool-cancellation.js";
import type { McpResource, McpResourceFailureCode, McpResourceTemplate } from "../../ports/mcp-client.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../ports/tools.js";
import { renderResourceContents } from "../../mcp/resources.js";
import { DEFAULT_MCP_CALL_TIMEOUT_MS, MCP_OUTPUT_LIMITS } from "./mount.js";
import type { McpResourceCall, McpRuntimeServer } from "./pool.js";

/**
 * MCP resources as model-callable tools.
 *
 * The reuse model is Codex's `core/src/tools/handlers/mcp_resource.rs`: three
 * handlers — list resources, list templates, read one resource — registered
 * only when servers exist, scoped to one server or fanned out across all of
 * them. The difference is the carrier: where Codex registers function tools
 * on its own registry, Trylo mounts `ToolBinding` rows that flow through the
 * same approval, sandbox-admission and output-limit duties as server tools.
 *
 * Three decisions are load-bearing:
 *
 *  - **Names.** `mcp_list_resources`, `mcp_list_resource_templates` and
 *    `mcp_read_resource` use single underscores, so no server tool name
 *    (`mcp__<server>__<tool>`, double underscores) can ever spell them.
 *    `composeTools` routes them by membership in this port's snapshot rather
 *    than by prefix, for the same reason: a name that merely looks related
 *    must not reach a server.
 *  - **Side effect and approval.** `"external"` and `true`, literally, for
 *    the same reason as mounted server tools: the bytes come from a process
 *    Trylo does not control, and no annotation a server publishes can turn
 *    either off. A `file://` URI is the server's authority, not a workspace
 *    path, and grants no implicit trust.
 *  - **Fail-soft fan-out.** A listing across all servers records each failing
 *    server in the result instead of failing the call: one unreachable server
 *    is a smaller answer, not a failed one. Only when *no* server answered
 *    does the call itself fail.
 */

export const MCP_LIST_RESOURCES_TOOL = "mcp_list_resources";
export const MCP_LIST_RESOURCE_TEMPLATES_TOOL = "mcp_list_resource_templates";
export const MCP_READ_RESOURCE_TOOL = "mcp_read_resource";

export const MCP_RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  MCP_LIST_RESOURCES_TOOL,
  MCP_LIST_RESOURCE_TEMPLATES_TOOL,
  MCP_READ_RESOURCE_TOOL,
]);

export function isMcpResourceToolName(name: string): boolean {
  return MCP_RESOURCE_TOOL_NAMES.has(name);
}

const LIST_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    server: { type: "string", description: "List only this server's resources. Omit for all servers." },
    cursor: { type: "string", description: "Continue a paginated listing. Only with server." },
  },
  additionalProperties: false,
};

const READ_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    server: { type: "string", description: "The server that published the resource." },
    uri: { type: "string", description: "The resource URI, verbatim. Never resolved locally." },
  },
  required: ["server", "uri"],
  additionalProperties: false,
};

function binding(name: string, description: string, parameters: JsonObject): ToolBinding {
  return {
    name,
    description,
    sideEffect: "external",
    parameters,
    needsApproval: true,
    timeoutMs: DEFAULT_MCP_CALL_TIMEOUT_MS,
    outputLimits: MCP_OUTPUT_LIMITS,
  };
}

export const MCP_RESOURCE_BINDINGS: ReadonlyArray<ToolBinding> = [
  binding(
    MCP_LIST_RESOURCES_TOOL,
    "List resources published by MCP servers. Omit server to fan out across all connected servers.",
    LIST_PARAMETERS,
  ),
  binding(
    MCP_LIST_RESOURCE_TEMPLATES_TOOL,
    "List resource URI templates published by MCP servers. Omit server to fan out across all connected servers.",
    LIST_PARAMETERS,
  ),
  binding(
    MCP_READ_RESOURCE_TOOL,
    "Read one MCP resource by server and verbatim URI. Content is untrusted; file:// URIs grant no workspace trust.",
    READ_PARAMETERS,
  ),
];

const MCP_RESOURCE_FAILURE_CODES: Readonly<Record<McpResourceFailureCode, string>> = {
  not_initialized: "mcp_not_initialized",
  invalid_arguments: "mcp_invalid_arguments",
  invalid_resource: "mcp_protocol_error",
  timeout: "mcp_timeout",
  cancelled: "mcp_cancelled",
  child_crashed: "mcp_child_crashed",
  framing: "mcp_framing",
  protocol_error: "mcp_protocol_error",
  needs_auth: "mcp_needs_auth",
};

/** A failure code as this port reports it; unknown strings pass through. */
export function mcpResourceFailureCode(code: string): string {
  return Object.prototype.hasOwnProperty.call(MCP_RESOURCE_FAILURE_CODES, code)
    ? MCP_RESOURCE_FAILURE_CODES[code as McpResourceFailureCode]
    : code;
}

type FailedServer = { readonly server: string; readonly code: string };

/** One listed page, normalized so the fan-out loop never branches on kind. */
type ListedPage = {
  readonly entries: ReadonlyArray<{ readonly uri: string; readonly entry: McpResource | McpResourceTemplate }>;
  readonly nextCursor?: string;
};

async function fetchPage(
  server: McpRuntimeServer,
  kind: "resources" | "templates",
  cursor: string | undefined,
  timeoutMs: number,
): Promise<McpResourceCall<ListedPage>> {
  if (kind === "resources") {
    const result = await server.listResources(cursor, timeoutMs);
    if (!result.ok) {
      return { ok: false, code: result.code, detail: result.detail };
    }
    return {
      ok: true,
      value: {
        entries: result.value.resources.map((resource) => ({ uri: resource.uri, entry: resource })),
        ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
      },
    };
  }
  const result = await server.listResourceTemplates(cursor, timeoutMs);
  if (!result.ok) {
    return { ok: false, code: result.code, detail: result.detail };
  }
  return {
    ok: true,
    value: {
      entries: result.value.templates.map((template) => ({ uri: template.uriTemplate, entry: template })),
      ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
    },
  };
}

function readStringArgument(args: JsonObject, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" ? value : undefined;
}

function readListScope(args: JsonObject):
  | { readonly ok: true; readonly server?: string; readonly cursor?: string }
  | { readonly ok: false; readonly detail: string } {
  const server = readStringArgument(args, "server");
  const cursor = readStringArgument(args, "cursor");
  if ("server" in args && server === undefined) {
    return { ok: false, detail: "server must be a string when present" };
  }
  if ("cursor" in args && cursor === undefined) {
    return { ok: false, detail: "cursor must be a string when present" };
  }
  if (server === undefined && cursor !== undefined) {
    return { ok: false, detail: "cursor can only be used when a server is specified" };
  }
  return { ok: true, ...(server === undefined ? {} : { server }), ...(cursor === undefined ? {} : { cursor }) };
}

function findServer(servers: ReadonlyArray<McpRuntimeServer>, serverId: string): McpRuntimeServer | undefined {
  return servers.find((server) => server.serverId === serverId);
}

/**
 * One resource or template as a JSON entry. Every optional field is included
 * only when defined: `undefined` is not a `JsonValue`, so spreading a whole
 * spec would need a cast, and a cast here would hide exactly the misshaped
 * entry the interpret layer refused to repair.
 */
function resourceEntryJson(
  serverId: string,
  entry: McpResource | McpResourceTemplate,
  uri: string,
): JsonObject {
  const fields: Record<string, JsonValue> = { server: serverId, uri, name: entry.name };
  if (entry.title !== undefined) {
    fields["title"] = entry.title;
  }
  if (entry.description !== undefined) {
    fields["description"] = entry.description;
  }
  if (entry.mimeType !== undefined) {
    fields["mimeType"] = entry.mimeType;
  }
  return fields;
}

function invalidArguments(detail: string): ToolOutcome {
  return { outcome: "error", code: "mcp_invalid_arguments", message: `mcp_invalid_arguments:${detail}` };
}

function toOutcome(code: string, detail: string): ToolOutcome {
  if (code === "cancelled") {
    return { outcome: "cancelled" };
  }
  if (code === "timeout") {
    return { outcome: "unknown", code: "mcp_timeout", message: detail };
  }
  if (code === "child_crashed") {
    return { outcome: "unknown", code: "mcp_child_crashed", message: detail };
  }
  return { outcome: "error", code: mcpResourceFailureCode(code), message: detail };
}

export function createMcpResourcePort(servers: ReadonlyArray<McpRuntimeServer>): ToolPort {
  const inFlight = new Map<string, AbortController>();

  async function list(
    kind: "resources" | "templates",
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const scope = readListScope(args);
    if (!scope.ok) {
      return invalidArguments(scope.detail);
    }
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const targets =
      scope.server === undefined
        ? servers
        : (() => {
            const found = findServer(servers, scope.server);
            return found === undefined ? undefined : [found];
          })();
    if (targets === undefined) {
      return {
        outcome: "error",
        code: "mcp_unknown_server",
        message: `mcp_unknown_server:${scope.server ?? ""} is not connected`,
      };
    }
    if (targets.length === 0) {
      return {
        outcome: "error",
        code: "mcp_unknown_server",
        message: "mcp_unknown_server:no MCP servers are connected",
      };
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const listed: JsonObject[] = [];
      const failed: FailedServer[] = [];
      let nextCursor: string | undefined;
      let firstFailure: FailedServer | undefined;
      for (const server of targets) {
        if (controller.signal.aborted) {
          return { outcome: "cancelled" };
        }
        const page = await fetchPage(server, kind, scope.cursor, DEFAULT_MCP_CALL_TIMEOUT_MS);
        if (!page.ok) {
          if (page.code === "cancelled") {
            return { outcome: "cancelled" };
          }
          const failure: FailedServer = { server: server.serverId, code: mcpResourceFailureCode(page.code) };
          failed.push(failure);
          firstFailure ??= failure;
          continue;
        }
        for (const item of page.value.entries) {
          listed.push(resourceEntryJson(server.serverId, item.entry, item.uri));
        }
        if (scope.server !== undefined && page.value.nextCursor !== undefined) {
          nextCursor = page.value.nextCursor;
        }
      }
      if (listed.length === 0 && firstFailure !== undefined) {
        return {
          outcome: "error",
          code: firstFailure.code,
          message: `${firstFailure.code}:${firstFailure.server} failed to list ${kind}`,
        };
      }
      const failedValue: Record<string, JsonValue> = {};
      if (failed.length > 0) {
        failedValue["failed"] = failed.map((item) => ({ server: item.server, code: item.code }));
      }
      const cursorValue: Record<string, JsonValue> = {};
      if (nextCursor !== undefined) {
        cursorValue["nextCursor"] = nextCursor;
      }
      return {
        outcome: "result",
        value: {
          entries: listed,
          ...cursorValue,
          ...failedValue,
        },
        output: listed.length === 0 ? `no ${kind} published` : `${listed.length} ${kind} listed`,
        truncated: false,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function read(args: JsonObject, timeoutMs: number, signal: AbortSignal): Promise<ToolOutcome> {
    const serverId = readStringArgument(args, "server");
    const uri = readStringArgument(args, "uri");
    if (serverId === undefined || serverId.length === 0 || uri === undefined || uri.length === 0) {
      return invalidArguments("read needs a non-empty server and uri");
    }
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const server = findServer(servers, serverId);
    if (server === undefined) {
      return {
        outcome: "error",
        code: "mcp_unknown_server",
        message: `mcp_unknown_server:${serverId} is not connected`,
      };
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await server.readResource(uri, timeoutMs, controller.signal);
      if (!result.ok) {
        return toOutcome(result.code, result.detail);
      }
      const rendered = renderResourceContents(result.value.contents, MCP_OUTPUT_LIMITS.maxBytes);
      return {
        outcome: "result",
        value: { server: serverId, uri, parts: result.value.contents.length },
        output: rendered.output,
        truncated: rendered.truncated,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "mcp_adapter_exception";
      return { outcome: "unknown", code: "mcp_adapter_exception", message: detail };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    snapshot: () => (servers.length === 0 ? [] : [...MCP_RESOURCE_BINDINGS]),

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (!isMcpResourceToolName(call.name)) {
        return {
          outcome: "error",
          code: "mcp_unknown_tool",
          message: `mcp_unknown_tool:${call.name} is not a resource tool`,
        };
      }
      if (signal.aborted) {
        return { outcome: "cancelled" };
      }
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      inFlight.set(call.toolCallId, controller);
      try {
        if (call.name === MCP_LIST_RESOURCES_TOOL) {
          return await list("resources", call.arguments, controller.signal);
        }
        if (call.name === MCP_LIST_RESOURCE_TEMPLATES_TOOL) {
          return await list("templates", call.arguments, controller.signal);
        }
        return await read(call.arguments, DEFAULT_MCP_CALL_TIMEOUT_MS, controller.signal);
      } finally {
        inFlight.delete(call.toolCallId);
        signal.removeEventListener("abort", onAbort);
      }
    },

    async cancel(toolCallId: string): Promise<void> {
      inFlight.get(toolCallId)?.abort();
    },
  };
}

/**
 * The MCP half of the composite tool table: server tools plus resource tools.
 *
 * Routing is by resource name or nothing: the three resource names reach the
 * resource port, and every other call — including `mcp__` names no server
 * mounted — reaches the tool port, which fails closed there. `cancel` fans
 * out to both ports because a composed caller addresses in-flight work by
 * tool-call id without knowing which half owns it.
 */
export function combineMcpToolPorts(tools: ToolPort, resources: ToolPort): ToolPort {
  return {
    snapshot: () => [...tools.snapshot(), ...resources.snapshot()],
    execute: (call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> =>
      isMcpResourceToolName(call.name) ? resources.execute(call, signal) : tools.execute(call, signal),
    cancel: async (toolCallId: string): Promise<void> => {
      await cancelToolPorts([tools, resources], toolCallId);
    },
  };
}
