/**
 * MCP tool naming.
 *
 * D3 §1 records the convention codex established: an external tool is
 * namespaced with a prefix so a provider tool name can never collide with a
 * built-in one. This package uses `mcp__<serverId>__<toolName>`.
 *
 * The format is only useful if it is *unambiguous*, and the obvious
 * implementation is not. If a tool may itself contain `__`, then
 * `mcp__a__b__c` could be server `a` with tool `b__c` or server `a__b` with
 * tool `c`. A registry entry whose name admitted `__` would let a server
 * publish a tool that parses as belonging to a *different* server — and a
 * future approval policy keyed on the server half would then be reading an
 * attacker-chosen value.
 *
 * Two rules eliminate it, and both are checked rather than assumed:
 *
 *  1. A server id never contains `__`. Registry names match
 *     `[a-z0-9][a-z0-9_-]{0,63}`, so a double underscore is impossible by
 *     construction.
 *  2. A tool name containing `__` is *refused*, not escaped. Encoding rules
 *     create a second language that every consumer must get right; refusing
 *     keeps the name a faithful copy of what the server said.
 *
 * With both rules in force the first `__` after the prefix is the only
 * separator, and parsing is genuinely reversible.
 */

export const MCP_TOOL_PREFIX = "mcp__";
export const MCP_NAME_SEPARATOR = "__";

export type McpQualifiedName = {
  readonly serverId: string;
  readonly serverToolName: string;
};

export type McpNameFailure = {
  readonly ok: false;
  readonly code: "invalid_server_id" | "invalid_tool_name" | "not_mcp_name" | "malformed_mcp_name";
  readonly detail: string;
};

export type McpNameResult =
  | { readonly ok: true; readonly value: McpQualifiedName }
  | McpNameFailure;

const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Builds the qualified name for one server tool.
 *
 * Returns a failure rather than throwing: a server that publishes a tool named
 * `a__b` is misbehaving, and the caller's job is to drop that tool and keep
 * serving the rest, not to tear down the connection.
 */
export function qualifyMcpToolName(
  serverId: string,
  serverToolName: string,
): { readonly ok: true; readonly value: string } | McpNameFailure {
  if (!SERVER_ID_PATTERN.test(serverId) || serverId.includes(MCP_NAME_SEPARATOR)) {
    return { ok: false, code: "invalid_server_id", detail: `server id ${JSON.stringify(serverId)} is not usable in a tool name` };
  }

  if (serverToolName.length === 0) {
    return { ok: false, code: "invalid_tool_name", detail: "tool name must not be empty" };
  }

  if (serverToolName.includes(MCP_NAME_SEPARATOR)) {
    return {
      ok: false,
      code: "invalid_tool_name",
      detail: `tool name ${JSON.stringify(serverToolName)} contains the server separator`,
    };
  }

  return { ok: true, value: `${MCP_TOOL_PREFIX}${serverId}${MCP_NAME_SEPARATOR}${serverToolName}` };
}

/**
 * Splits a qualified name back into its parts.
 *
 * A name that is not prefixed with `mcp__` is `not_mcp_name`: that is a normal
 * answer, not an error — most names a caller holds are built-in tools.
 */
export function parseMcpToolName(qualifiedName: string): McpNameResult {
  if (!qualifiedName.startsWith(MCP_TOOL_PREFIX)) {
    return { ok: false, code: "not_mcp_name", detail: "not an mcp tool name" };
  }

  const rest = qualifiedName.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf(MCP_NAME_SEPARATOR);
  if (separator <= 0 || separator === rest.length - MCP_NAME_SEPARATOR.length) {
    // Covers `mcp__`, `mcp__x`, `mcp__x__`, and `mcp____y`: all of them have an
    // empty half, and an empty half is never a legal server id or tool name.
    return { ok: false, code: "malformed_mcp_name", detail: `cannot split ${JSON.stringify(qualifiedName)}` };
  }

  const serverId = rest.slice(0, separator);
  const serverToolName = rest.slice(separator + MCP_NAME_SEPARATOR.length);

  if (!SERVER_ID_PATTERN.test(serverId)) {
    return { ok: false, code: "malformed_mcp_name", detail: `server half ${JSON.stringify(serverId)} is not a valid id` };
  }

  if (serverToolName.includes(MCP_NAME_SEPARATOR)) {
    // With the first separator consumed, a second one in the remainder means
    // the name was produced outside this module (or by a server id that
    // illegally contains `__`). Either way it is not round-trippable.
    return {
      ok: false,
      code: "malformed_mcp_name",
      detail: `tool half ${JSON.stringify(serverToolName)} contains a separator`,
    };
  }

  return { ok: true, value: { serverId, serverToolName } };
}

export function isMcpQualifiedName(value: string): boolean {
  return parseMcpToolName(value).ok;
}

/**
 * The property this module exists for, stated once so the test can quote it:
 * qualifying then parsing returns exactly the inputs.
 */
export function isRoundTrippable(serverId: string, serverToolName: string): boolean {
  const qualified = qualifyMcpToolName(serverId, serverToolName);
  if (!qualified.ok) {
    return false;
  }

  const parsed = parseMcpToolName(qualified.value);

  return (
    parsed.ok &&
    parsed.value.serverId === serverId &&
    parsed.value.serverToolName === serverToolName
  );
}
