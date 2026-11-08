import type { ToolPort } from "../../../ports/tools.js";
import { READ_ONLY_BINDINGS } from "../../../adapters/tools/read-only/bindings.js";
import { MUTATING_BINDINGS } from "../../../adapters/tools/mutating/bindings.js";
import type { McpPool } from "../../../adapters/mcp-runtime/pool.js";
import { parseMcpToolName } from "../../../mcp/names.js";
import { readToolAssetInventory } from "../../../learning/agent/subsystems/tool/runtime/index.js";
import { runtimeToolId } from "../resolution.js";
import type { ToolBindingMetadata, ToolLibraryEntry, ToolLibrarySource, ToolMetadata } from "../contracts.js";

/** Live tools are authoritative for availability; declarations never synthesize an executor. */
export function createRuntimeToolSource(options: {
  readonly tools: ToolPort;
  readonly metadata?: ToolBindingMetadata;
  /** Include optional builtins from the original workspace-tool owner, never the composite MCP port. */
  readonly builtinNames?: ReadonlySet<string>;
  readonly mcpPool?: McpPool;
  readonly production?: { readonly boardRoot: string; readonly workspaceId: string };
}): ToolLibrarySource {
  return { id: "runtime", async read(context) {
    const entries: ToolLibraryEntry[] = options.tools.snapshot().map(binding => {
      const metadata = options.metadata?.(binding) ?? originOf(binding.name, options.builtinNames);
      return { id: runtimeToolId(binding.name), name: binding.name, description: binding.description,
        capabilities: metadata.capabilities ?? [binding.name], source: metadata.source, availability: { state: "available" },
        runtimeName: binding.name, ...(metadata.lifecycle === undefined ? {} : { lifecycle: metadata.lifecycle }) };
    });

    if (options.production !== undefined && context.scope === options.production.workspaceId) {
      const inventory = await productionEntries(options.production, options.tools);
      if (!inventory.ok) return inventory;
      for (const entry of inventory.value) {
        const index = entries.findIndex(row => row.id === entry.id);
        if (index < 0) entries.push(entry); else entries[index] = entry;
      }
    }

    for (const failure of options.mcpPool?.failures ?? []) entries.push({ id: `mcp-server:${failure.serverId || "registry"}`,
      name: failure.serverId || "MCP registry", description: "已登记的 MCP 来源未能建立工具运行会话。", capabilities: [],
      source: { kind: "mcp", label: failure.serverId || "MCP registry" }, availability: { state: "unavailable", reason: failure.code } });

    for (const skipped of options.mcpPool?.skipped ?? []) entries.push({ id: `mcp-server:${skipped.serverId}`, name: skipped.serverId,
      description: "现有配置已禁用此 MCP 来源。", capabilities: [], source: { kind: "mcp", label: skipped.serverId },
      availability: { state: "unavailable", reason: "source_disabled" } });

    return { ok: true, value: entries };
  } };
}

const standardBuiltinNames = new Set([...READ_ONLY_BINDINGS, ...MUTATING_BINDINGS].map(binding => binding.name));

function originOf(name: string, builtinNames?: ReadonlySet<string>): ToolMetadata {
  const mcp = parseMcpToolName(name);
  if (mcp.ok) return { source: { kind: "mcp", label: mcp.value.serverId }, capabilities: [name, mcp.value.serverToolName] };
  if (name.startsWith("learned__")) return { source: { kind: "learned", label: "已挂载学习工具" } };
  if (standardBuiltinNames.has(name) || builtinNames?.has(name)) return { source: { kind: "builtin", label: "Trylo 内置工具" } };
  return { source: { kind: "external", label: "已挂载工具（来源待标注）" } };
}

async function productionEntries(input: { readonly boardRoot: string; readonly workspaceId: string }, tools: ToolPort) {
  const inventory = await readToolAssetInventory(input.boardRoot, input.workspaceId);
  if (!inventory.ok) return inventory;

  const entries: ToolLibraryEntry[] = [];

  for (const item of inventory.items) {
    const name = item.runtimeName;
    const mounted = name !== undefined && tools.snapshot().some(binding => binding.name === name);
    entries.push({ id: name === undefined ? `learned-asset:${item.versionId}` : runtimeToolId(name), name: item.identity, description: item.description,
      capabilities: item.capabilities, source: { kind: "learned", label: item.identity, ...(item.version === undefined ? {} : { version: item.version }), reference: item.versionId }, lifecycle: item.lifecycle,
      availability: mounted ? { state: "available" } : { state: "unavailable", reason: item.reason ?? (item.lifecycle === "active" ? "runtime_not_mounted" : "production_not_active") },
      ...(name === undefined ? {} : { runtimeName: name }) });
  }

  return { ok: true as const, value: entries };
}

/** Existing package/catalog owners can contribute declarations without claiming installation or approval. */
export function createDeclaredToolSource(id: string, read: ToolLibrarySource["read"]): ToolLibrarySource { return { id, read }; }
