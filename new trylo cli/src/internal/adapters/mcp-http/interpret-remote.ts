import type {
  McpCallFailure,
  McpConnectFailure,
  McpConnectFailureCode,
  McpResourceFailure,
  McpServerInfo,
  McpToolListFailure,
  McpToolOutcome,
  McpToolSpec,
} from "../../ports/mcp-client.js";
import {
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
} from "../../ports/mcp-client.js";
import { paramsAsObject, type JsonRpcResponse } from "../../mcp/jsonrpc.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { extractText, isInputRequired, timeoutOutcome, toToolSpec } from "../mcp-stdio/client-interpret.js";
import { attachMcpImages } from "../../mcp/image-content.js";
import type { RemoteTransportFailure } from "./wire.js";

/**
 * Reply interpretation for the remote transports, split from the lifecycle
 * for the same reason the stdio client splits its own: every hostile reply
 * shape is a pure unit test, not a socket session.
 *
 * The *rules* live in the shared pure helpers of `mcp-stdio/client-interpret.ts`
 * (`extractText`, `isInputRequired`, `timeoutOutcome`, `toToolSpec`) and are
 * reused, not copied; what is written here is only the transport-shaped glue.
 * The stdio module's own interpreters take a `StdioTransport` they do not
 * need, so they cannot be called from here without inventing a process — the
 * stdio files are not in this track's write-set, and refactoring them for
 * cosmetics is how a track gets blocked at a parallel boundary.
 */

export function interpretRemoteInitialize(
  response: JsonRpcResponse,
  serverId: string,
): { readonly ok: true; readonly value: McpServerInfo } | McpConnectFailure {
  if ("error" in response) {
    return {
      ok: false,
      code: "handshake_rejected",
      detail: `${serverId} refused initialize: ${response.error.code} ${response.error.message}`,
    };
  }
  const result = paramsAsObject(response.result);
  if (result === undefined) {
    return { ok: false, code: "invalid_server_info", detail: "initialize result is not an object" };
  }
  const version = result["protocolVersion"];
  if (typeof version !== "string") {
    return { ok: false, code: "invalid_server_info", detail: "initialize result has no protocolVersion" };
  }
  if (!isSupportedProtocolVersion(version)) {
    return {
      ok: false,
      code: "unsupported_protocol_version",
      detail: `${serverId} speaks ${version}; supported: ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(", ")}`,
    };
  }
  const rawServerInfo = paramsAsObject(result["serverInfo"]);
  const name = typeof rawServerInfo?.["name"] === "string" ? rawServerInfo["name"] : serverId;
  const serverVersion = typeof rawServerInfo?.["version"] === "string" ? rawServerInfo["version"] : "unknown";
  const capabilities = paramsAsObject(result["capabilities"]) ?? {};
  const instructions = result["instructions"];
  return {
    ok: true,
    value: {
      name,
      version: serverVersion,
      protocolVersion: version,
      capabilities,
      ...(typeof instructions === "string" ? { instructions } : {}),
    },
  };
}

/** Same tool-list rules as stdio, via the shared `toToolSpec`. */
export function interpretRemoteToolList(
  response: JsonRpcResponse,
  serverId: string,
  dropped: string[],
): { readonly ok: true; readonly value: ReadonlyArray<McpToolSpec> } | McpToolListFailure {
  if ("error" in response) {
    return {
      ok: false,
      code: "protocol_error",
      detail: `tools/list failed: ${response.error.code} ${response.error.message}`,
    };
  }
  const result = paramsAsObject(response.result);
  const tools = result?.["tools"];
  if (!Array.isArray(tools)) {
    return { ok: false, code: "invalid_tool_spec", detail: "tools/list result has no tools array" };
  }
  const specs: McpToolSpec[] = [];
  for (const raw of tools) {
    const spec = toToolSpec(raw, serverId, dropped);
    if (spec !== undefined) {
      specs.push(spec);
    }
  }
  return { ok: true, value: specs };
}

/**
 * Maps a `tools/call` reply to the outcome vocabulary, without the stdio-only
 * branches: a remote server has no stderr, so "the server went away" arrives
 * as a wire failure, not as a reply to interpret.
 */
export function interpretRemoteToolResult(response: JsonRpcResponse): McpToolOutcome {
  if ("error" in response) {
    return {
      outcome: "error",
      code: "mcp_protocol_error",
      message: `${response.error.code} ${response.error.message}`,
    };
  }
  const result = paramsAsObject(response.result);
  if (result === undefined) {
    return { outcome: "unknown", code: "mcp_framing", message: "tools/call result is not an object" };
  }
  const text = extractText(result["content"]);
  if (result["isError"] === true) {
    return { outcome: "error", code: "mcp_tool_error", message: text.length > 0 ? text : "server reported isError" };
  }
  if (isInputRequired(result)) {
    return {
      outcome: "unknown",
      code: "mcp_capability_unsupported",
      message: "server requested a multi-round-trip result, which this client does not implement",
    };
  }
  const structured = result["structuredContent"];
  const value: JsonObject =
    typeof structured === "object" && structured !== null && !Array.isArray(structured)
      ? (structured as JsonObject)
      : {};
  return attachMcpImages({ outcome: "result", value, output: text, truncated: false }, result["content"]);
}

export const remoteTimeoutOutcome = timeoutOutcome;

/** Wire failure → connect failure. One row per wire code, stated once. */
export function wireFailureToConnect(failure: RemoteTransportFailure): McpConnectFailure {
  return { ok: false, code: WIRE_TO_CONNECT[failure.code], detail: failure.detail };
}

/** Wire failure → tool-list failure. */
export function wireFailureToToolList(failure: RemoteTransportFailure): McpToolListFailure {
  return { ok: false, code: WIRE_TO_TOOL_LIST[failure.code], detail: failure.detail };
}

/** Wire failure → call failure for the codes that are a refusal, not a crash. */
export function wireFailureToCall(failure: RemoteTransportFailure): McpCallFailure {
  return { ok: false, code: WIRE_TO_CALL[failure.code], detail: failure.detail };
}

/** Wire failure → resource failure. Same refusal/crash split as tools/call. */
export function wireFailureToResource(failure: RemoteTransportFailure): McpResourceFailure {
  return { ok: false, code: WIRE_TO_RESOURCE[failure.code], detail: failure.detail };
}

const WIRE_TO_CONNECT: Readonly<Record<RemoteTransportFailure["code"], McpConnectFailureCode>> = {
  unreachable: "spawn_failed",
  rejected: "handshake_rejected",
  framing: "framing",
  server_gone: "child_exited",
  write_failed: "spawn_failed",
  needs_auth: "needs_auth",
};

const WIRE_TO_TOOL_LIST: Readonly<Record<RemoteTransportFailure["code"], McpToolListFailure["code"]>> = {
  unreachable: "child_exited",
  rejected: "protocol_error",
  framing: "framing",
  server_gone: "child_exited",
  write_failed: "child_exited",
  needs_auth: "needs_auth",
};

const WIRE_TO_CALL: Readonly<Record<RemoteTransportFailure["code"], McpCallFailure["code"]>> = {
  unreachable: "child_crashed",
  rejected: "protocol_error",
  framing: "framing",
  server_gone: "child_crashed",
  write_failed: "child_crashed",
  needs_auth: "needs_auth",
};

const WIRE_TO_RESOURCE: Readonly<Record<RemoteTransportFailure["code"], McpResourceFailure["code"]>> = {
  unreachable: "child_crashed",
  rejected: "protocol_error",
  framing: "framing",
  server_gone: "child_crashed",
  write_failed: "child_crashed",
  needs_auth: "needs_auth",
};

/** The remote version of "the child crashed": no stderr to measure. */
export function remoteCrashedOutcome(detail: string): McpToolOutcome {
  return { outcome: "unknown", code: "mcp_child_crashed", message: detail };
}
