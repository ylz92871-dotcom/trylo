import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { readAnnotations } from "../../mcp/annotations.js";
import { parseMcpToolName, qualifyMcpToolName } from "../../mcp/names.js";
import {
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  type McpConnectFailure,
  type McpServerInfo,
  type McpToolListFailure,
  type McpToolOutcome,
  type McpToolSpec,
} from "../../ports/mcp-client.js";
import { paramsAsObject, type JsonRpcResponse } from "../../mcp/jsonrpc.js";
import type { StdioTransport } from "./transport.js";
import { attachMcpImages } from "../../mcp/image-content.js";

/**
 * Response interpretation, split out of the client so the lifecycle module can
 * stay about ordering.
 *
 * Everything here is pure: no process is touched, no clock is read, and no state
 * survives the call. That is deliberate — it means every hostile reply shape
 * (an error object, a missing `protocolVersion`, a tool whose name contains
 * `__`, a `content` array of non-objects) is a unit test that needs neither a
 * spawned child nor a fake timer.
 */

/**
 * Splits a qualified name, or `undefined` when it is not one this package
 * could have produced. Delegates to `mcp/names.ts` rather than re-implementing
 * the separator rule: two copies of a naming rule is how they drift apart.
 */
export function splitQualified(name: string): { readonly serverId: string; readonly serverToolName: string } | undefined {
  const parsed = parseMcpToolName(name);
  return parsed.ok ? parsed.value : undefined;
}

export function interpretInitialize(
  activeTransport: StdioTransport,
  response: JsonRpcResponse,
  serverId: string,
):
  | { readonly ok: true; readonly value: McpServerInfo }
  | McpConnectFailure {
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
  // `activeTransport` is accepted so the signature matches the other
  // interpreters; initialize does not need to close anything itself.
  void activeTransport;
}

export function interpretToolList(
  activeTransport: StdioTransport,
  response: JsonRpcResponse,
  serverId: string,
  dropped: string[],
):
  | { readonly ok: true; readonly value: ReadonlyArray<McpToolSpec> }
  | McpToolListFailure {
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
  void activeTransport;
  return { ok: true, value: specs };
}

/**
 * One published tool, or `undefined` when it cannot be addressed.
 *
 * A tool without a usable name or without an object `inputSchema` is dropped
 * rather than repaired: guessing at a schema is how a caller ends up sending
 * arguments the server never agreed to accept.
 */
export function toToolSpec(raw: JsonValue, serverId: string, dropped: string[]): McpToolSpec | undefined {
  const record = paramsAsObject(raw);
  if (record === undefined) {
    return undefined;
  }
  const serverToolName = record["name"];
  if (typeof serverToolName !== "string") {
    return undefined;
  }
  const qualified = qualifyMcpToolName(serverId, serverToolName);
  if (!qualified.ok) {
    dropped.push(serverToolName);
    return undefined;
  }
  const inputSchema = record["inputSchema"];
  if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
    dropped.push(serverToolName);
    return undefined;
  }
  const description = record["description"];
  return {
    serverToolName,
    qualifiedName: qualified.value,
    serverId,
    description: typeof description === "string" ? description : "",
    inputSchema: inputSchema as JsonObject,
    annotations: readAnnotations(record["annotations"]),
    annotationsTrust: "untrusted",
    needsApproval: true,
  };
}

/**
 * Maps a `tools/call` response to this package's outcome vocabulary.
 *
 * The MCP convention (D3 §2) is a *double track*: a protocol-level failure is a
 * JSON-RPC error, while a tool that ran and failed sends `isError: true` inside
 * a successful result. The two are not interchangeable — the first is
 * `unknown` (nothing is known about whether the effect happened), the second is
 * `error` (the server is telling us it failed).
 */
export function interpretToolResult(response: JsonRpcResponse, activeTransport: StdioTransport): McpToolOutcome {
  if ("error" in response) {
    const message = `${response.error.code} ${response.error.message}`;
    if (message.includes("capability_unsupported")) {
      return { outcome: "unknown", code: "mcp_capability_unsupported", message };
    }
    if (message.includes("timeout")) {
      return { outcome: "unknown", code: "mcp_timeout", message };
    }
    if (message.includes("framing")) {
      return { outcome: "unknown", code: "mcp_framing", message };
    }
    if (message.includes("child_exited")) {
      return crashedOutcome(activeTransport);
    }
    return { outcome: "error", code: "mcp_protocol_error", message };
  }
  const result = paramsAsObject(response.result);
  if (result === undefined) {
    return { outcome: "unknown", code: "mcp_framing", message: "tools/call result is not an object" };
  }
  const content = result["content"];
  const text = extractText(content);
  if (result["isError"] === true) {
    // The tool ran and reported failure: this is an `error`, not an `unknown`.
    return { outcome: "error", code: "mcp_tool_error", message: text.length > 0 ? text : "server reported isError" };
  }
  if (isInputRequired(result)) {
    // A multi-round-trip result cannot be represented by a single call outcome
    // (D3 §10.11). Refusing keeps the loop's turn semantics honest.
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
  return attachMcpImages({ outcome: "result", value, output: text, truncated: false }, content);
}

/** The MCP draft's marker for "this call is not finished". */
export function isInputRequired(result: JsonObject): boolean {
  const resultType = result["resultType"];
  return resultType === "input_required" || resultType === "inputRequired";
}

export function extractText(content: JsonValue | undefined): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    const record = paramsAsObject(item);
    if (record === undefined) {
      continue;
    }
    if (record["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"]);
    }
  }
  return parts.join("\n");
}

export function timeoutOutcome(): McpToolOutcome {
  return {
    outcome: "unknown",
    code: "mcp_timeout",
    message: "the server did not answer before the deadline",
  };
}

export function crashedOutcome(activeTransport: StdioTransport): McpToolOutcome {
  return {
    outcome: "unknown",
    code: "mcp_child_crashed",
    message: `the server process exited (stderr ${activeTransport.stderrBytes()} bytes)`,
  };
}
