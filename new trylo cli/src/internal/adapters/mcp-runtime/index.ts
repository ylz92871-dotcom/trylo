import type { McpRegistryPort, McpServerEntry } from "../../ports/mcp-registry.js";
import type { ToolPort } from "../../ports/tools.js";
import { noOverlay } from "../../learning/domains/tool/refine/overlay.js";
import type { DescriptionOverlay } from "../../learning/domains/tool/refine/types.js";
import { createMcpToolPort } from "./execute.js";
import { createClientForEntry, type McpClientOpen } from "./factory.js";
import { mountServerTools, mountedNameSet, type McpMount } from "./mount.js";
import { openMcpPool, type McpPool, type McpRuntimeServer } from "./pool.js";
import {
  combineMcpToolPorts,
  createMcpResourcePort,
} from "./resources.js";

/**
 * The production composition layer for MCP: registry in, a tool table out.
 *
 * This is the module the CLI composition root names and nothing else does. It
 * exists because "the parts are all built" and "the run has external tools" are
 * different claims, and only this file makes the second one true — the clients,
 * the registry store and the naming rules were all delivered and tested before
 * it, with no caller in production.
 *
 * Everything it returns is either already-open (servers, tools) or already-told
 * (warnings). It starts no server on demand and caches nothing: whether the
 * session is one run or many is the caller's decision, and this layer is happy
 * to be opened once per run or once per session.
 *
 * The warnings are the run's honest diagnostics, in the surface vocabulary the
 * journal already projects diagnostics through: a server that did not come up,
 * a server the user disabled, a tool refused at mount time, and — keys only —
 * which header names a remote server carries. No header *value* is ever part of
 * a warning, and no MCP failure ever becomes a fatal error: a run with an
 * unreachable server is a run with fewer tools.
 */

export type McpRuntimeInput = {
  readonly registry: McpRegistryPort;
  readonly cwd: string;
  /** Injection seam for tests; production passes nothing. */
  readonly clientFor?: (entry: McpServerEntry, cwd: string) => McpClientOpen;
  /**
   * The A-description-refinement overlay (P05 tool learning §6). Absent means
   * the descriptions are the servers' own — which is what every caller before
   * this seam existed got, and what a run with learning switched off still gets.
   */
  readonly descriptionOverlay?: DescriptionOverlay;
};

export type McpRuntime = {
  /** The MCP half of the composite tool table. */
  readonly tools: ToolPort;
  /** Exactly the names that mounted, for the composite sandbox's admission set. */
  readonly toolNames: ReadonlySet<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly servers: ReadonlyArray<McpRuntimeServer>;
  close(): Promise<void>;
};

export async function openMcpRuntime(input: McpRuntimeInput): Promise<McpRuntime> {
  const pool = await openMcpPool({
    registry: input.registry,
    cwd: input.cwd,
    clientFor: input.clientFor ?? createClientForEntry,
  });
  const mount = mountServerTools(pool.servers, input.descriptionOverlay ?? noOverlay);
  const tools = createMcpToolPort(mount.mounted, input.cwd);
  const resources = createMcpResourcePort(pool.servers);
  return {
    tools: combineMcpToolPorts(tools, resources),
    toolNames: new Set([...mountedNameSet(mount.mounted), ...resources.snapshot().map((binding) => binding.name)]),
    warnings: warningsOf(pool, mount),
    servers: pool.servers,
    close: () => pool.closeAll(),
  };
}

/**
 * One line per fact, and no line for a fact that did not happen. The order is
 * the order the facts were discovered: failures, skips, refusals, then the
 * count of what did come up — so a reader sees the problems first.
 */
function warningsOf(pool: McpPool, mount: McpMount): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const failure of pool.failures) {
    lines.push(
      failure.serverId.length === 0
        ? `mcp_registry_unavailable:${failure.code}`
        : `mcp_server_unavailable:${failure.serverId}:${failure.code}`,
    );
  }
  for (const skipped of pool.skipped) {
    lines.push(`mcp_server_disabled:${skipped.serverId}`);
  }
  for (const refused of mount.refused) {
    lines.push(`mcp_tool_refused:${refused.qualifiedName}:${refused.code}`);
  }
  for (const entry of pool.headerKeys) {
    lines.push(`mcp_header_keys:${entry.serverId}:${entry.keys.join(",")}`);
  }
  if (pool.servers.length > 0) {
    lines.push(`mcp_servers_connected:${pool.servers.length}`);
  }
  return lines;
}

export { createClientForEntry } from "./factory.js";
export { createMcpToolPort, callTimeoutMs } from "./execute.js";
export {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  MAX_MCP_CALL_TIMEOUT_MS,
  MIN_MCP_CALL_TIMEOUT_MS,
  MCP_OUTPUT_LIMITS,
  bindingForSpec,
  composeSandbox,
  composeTools,
  isMcpToolName,
  mountServerTools,
  mountedNameSet,
} from "./mount.js";
export { openMcpPool, type McpHeaderKeys, type McpRuntimeServer } from "./pool.js";
export {
  combineMcpToolPorts,
  createMcpResourcePort,
  isMcpResourceToolName,
  MCP_LIST_RESOURCES_TOOL,
  MCP_LIST_RESOURCE_TEMPLATES_TOOL,
  MCP_READ_RESOURCE_TOOL,
  MCP_RESOURCE_BINDINGS,
} from "./resources.js";
export type { McpClientOpen } from "./factory.js";
export type { McpMountedTool, McpMount, McpRefusedTool } from "./mount.js";
export type { McpOpenFailure, McpPool, McpSkippedServer } from "./pool.js";
