import type { McpRuntime, McpRuntimeInput } from "./index.js";
import { openMcpRuntime } from "./index.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../ports/tools.js";
import { connectBroker, type BrokerClient } from "./broker-client.js";
import { brokerToolOutcome } from "./broker-errors.js";
import { createBrokerEngine } from "./broker-engine.js";
import { digest, isRow, object, record, type BrokerRow } from "./broker-contract.js";
import { bindingForSpec, DEFAULT_MCP_CALL_TIMEOUT_MS, type McpMountedTool } from "./mount.js";
import { createMcpToolPort } from "./execute.js";
import { createMcpResourcePort, combineMcpToolPorts } from "./resources.js";
import type { McpRuntimeServer } from "./pool.js";
import { callResult, listResult, templatesResult, readResult } from "./broker-results.js";
import { discoveryProvider, INVOKE_SPEC, MCP_SEARCH } from "./discovery-provider.js";
import { candidateSearchServers, rankSearchTools, readSearchOptions } from "./search.js";
import { registryDiagnosticWarning } from "../mcp-registry/diagnostics.js";
import { INITIAL_SEARCH_GATE, applySearch, applySchemaLoad, evaluateToolCall, type SearchGateState } from "../../tooling/deferred/index.js";

type Scope = {
    readonly root: string;
    readonly scope: string;
    readonly policy: string;
};

function rows(value: unknown): readonly BrokerRow[] {
    if (!Array.isArray(value) || !value.every(isRow))
        throw new Error("mcp_broker_invalid_catalog");
    return value;
}

const limits = { maxBytes: 60000, maxLines: 1000 };

function binding(spec: typeof INVOKE_SPEC, readOnly = false): ToolBinding {
    return { ...spec, sideEffect: readOnly ? "read_only" : "external", needsApproval: !readOnly,
        timeoutMs: DEFAULT_MCP_CALL_TIMEOUT_MS, outputLimits: limits };
}

async function localClient(input: McpRuntimeInput, names: readonly string[]): Promise<BrokerClient> {
    const entries = await Promise.all(names.map(async (name) => {
        const result = await input.registry.resolve(name);
        if (!result.ok)
            throw new Error(`mcp_registry_${result.code}`);
        return result.value.entry;
    }));
    const engine = createBrokerEngine({ entries, cwd: input.cwd, ...(input.clientFor ? { clientFor: input.clientFor } : {}) });

    return { key: "host-owned", close: () => engine.close(), async request(raw, signal = new AbortController().signal) {
            if (!record(raw))
                throw new Error("invalid_broker_request");

            if (raw.method === "load" && typeof raw.server === "string")
                await engine.ensure(raw.server);

            if (raw.method === "call" && typeof raw.server === "string" && typeof raw.tool === "string"
                && typeof raw.schemaHash === "string" && object(raw.arguments)
                && (raw.timeoutMs === undefined || typeof raw.timeoutMs === "number" && Number.isSafeInteger(raw.timeoutMs) && raw.timeoutMs > 0)) {
                return engine.call(raw.server, raw.tool, raw.schemaHash, raw.arguments, raw.timeoutMs, signal);
            }

            if (raw.method === "resource")
                return engine.resource(raw, signal);

            return engine.snapshot();
        } };
}

/** Cached connection metadata never grants execution: only a search that has
 * observed the live server loads schemas into this turn's canonical tool port. */
export async function openProgressiveMcpRuntime(input: McpRuntimeInput, scope: Scope): Promise<McpRuntime> {
    const names = await input.registry.names();
    if (!names.ok || names.value.length === 0)
        return openMcpRuntime(input);

    let client: BrokerClient;
    const warnings: string[] = (names.diagnostics ?? []).map(registryDiagnosticWarning);

    if (input.clientFor) {
        // Custom clients carry host-owned observers/closures and cannot be serialized
        // to another process. Keep that lifecycle with its existing host.
        client = await localClient(input, names.value);
    }
    else {
        try {
            client = await connectBroker({ ...scope, registry: input.registry, cwd: input.cwd });
        }
        catch {
            // A private-host failure must not make optional MCP a prerequisite for chat.
            // Retain on-demand tools with this turn as owner; never replay a tool call.
            warnings.push("mcp_background_host_unavailable: using turn-owned on-demand connections");
            client = await localClient(input, names.value);
        }
    }

    let catalog: readonly BrokerRow[];

    try {
        catalog = rows(await client.request({ method: "status" }));
    }
    catch {
        // A host can exit between its startup receipt and the first status read.
        // No business operation has been dispatched, so turn-owned discovery is safe.
        await client.close();
        warnings.push("mcp_background_host_disconnected: using turn-owned on-demand connections");
        client = await localClient(input, names.value);
        catalog = rows(await client.request({ method: "status" }));
    }

    const loaded = new Map<string, McpMountedTool>();
    const liveNames = new Set<string>([MCP_SEARCH, INVOKE_SPEC.name]);
    let gate: SearchGateState = INITIAL_SEARCH_GATE;
    const canCall = (name: string): boolean => {
        const route = loaded.get(name);
        return evaluateToolCall({ state: gate, toolName: name, expectedGeneration: 0,
            entry: route ? { name, shouldDefer: true, alwaysLoad: false, schemaVersion: digest(route.spec), packageVersionId: client.key } : undefined }).ok;
    };

    function serverProxy(serverId: string): McpRuntimeServer {
        return { serverId, tools: [], async call(tool, args, timeoutMs, signal) {
                const spec = loaded.get(`mcp__${serverId}__${tool}`)?.spec;
                if (!spec)
                    return { ok: false, code: "schema_not_loaded", detail: "Search and load this tool first." };

                try {
                    return callResult(await client.request({ method: "call", server: serverId, tool, arguments: args, timeoutMs, schemaHash: digest(spec) }, signal));
                }
                catch (error) {
                    if (signal.aborted)
                        return { ok: true, outcome: { outcome: "cancelled" } };
                    throw error;
                }
            },
            async listResources(cursor) { return listResult(await client.request({ method: "resource", server: serverId, operation: "list", cursor })); },
            async listResourceTemplates(cursor) { return templatesResult(await client.request({ method: "resource", server: serverId, operation: "templates", cursor })); },
            async readResource(uri, _timeout, signal) {
                try {
                    return readResult(await client.request({ method: "resource", server: serverId, operation: "read", uri }, signal));
                }
                catch (error) {
                    if (signal.aborted)
                        return { ok: false, code: "cancelled", detail: "Resource request cancelled" };
                    throw error;
                }
            },
            close: async () => { } };
    }

    const proxies = catalog.map(row => serverProxy(row.serverId));
    const search = binding({ name: MCP_SEARCH,
        description: `Discover configured tool definitions before calling them with mcp_call_tool. Supply query to search capabilities (Chinese and English are supported); server is optional. Omit both server and query for an immediate status snapshot. Select one server to wait only for it. Available server identifiers: ${catalog.map(row => row.serverId).join(", ")}. Search never executes a business tool or grants permission.`,
        parameters: { type: "object", properties: { server: { type: "string" }, query: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, additionalProperties: false } }, true);
    const inFlight = new Map<string, AbortController>();
    const tools: ToolPort = {
        snapshot: () => [search, binding(INVOKE_SPEC), ...[...loaded.values()].map(item => item.binding)],
        async execute(call, signal) {
            const controller = new AbortController();

            inFlight.set(call.toolCallId, controller);
            const combined = AbortSignal.any([signal, controller.signal]);

            try {
                return await execute(call, combined);
            }
            catch (error) {
                if (combined.aborted)
                    return { outcome: "cancelled" };
                const transport = brokerToolOutcome(error);
                if (transport !== undefined)
                    return transport;
                return { outcome: "unknown", code: "mcp_broker_unavailable", message: error instanceof Error ? error.message : "MCP connection unavailable" };
            }
            finally {
                inFlight.delete(call.toolCallId);
            }
        },
        cancel: async (id) => { inFlight.get(id)?.abort(); },
    };

    async function execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
        if (signal.aborted)
            return { outcome: "cancelled" };

        if (call.name !== MCP_SEARCH) {
            if (!canCall(call.name))
                return { outcome: "error", code: "schema_not_loaded", message: "Use mcp_search_tools to load the exact tool definition before calling it." };
            return createMcpToolPort([...loaded.values()], input.cwd).execute(call, signal);
        }

        const options = readSearchOptions(call.arguments);
        if (!options.ok)
            return { outcome: "error", code: "invalid_arguments", message: options.message };

        const { query, limit } = options.value;
        const server = call.arguments.server;
        if (server === undefined && query === "") {
            const value = rows(await client.request({ method: "status" }, signal)).map(({ serverId, state, reason }) => ({ serverId, state, ...(reason ? { reason } : {}) }));
            return { outcome: "result", value: { servers: value }, output: JSON.stringify({ servers: value }), truncated: false };
        }

        if (server !== undefined && (typeof server !== "string" || !catalog.some(row => row.serverId === server)))
            return { outcome: "error", code: "unknown_server", message: "Choose an exact configured server identifier." };

        const candidates = typeof server === "string" ? [server]
            : candidateSearchServers(catalog.map(row => row.serverId), query);
        const current = await Promise.all(candidates.map(async name => {
            const observed = rows(await client.request({ method: "load", server: name }, signal)).find(row => row.serverId === name);
            if (!observed)
                throw new Error("mcp_broker_invalid_catalog");
            return observed;
        }));

        if (signal.aborted)
            return { outcome: "cancelled" };
        if (server !== undefined && current[0]?.state !== "ready")
            return { outcome: "error", code: "mcp_unavailable", message: `Server ${server} unavailable: ${current[0]?.reason ?? "not_ready"}.` };

        const ranked = rankSearchTools(current.flatMap(row => row.state === "ready" ? row.tools : []), query);
        const result: {
            name: string;
            description: string;
            parameters: import("../../protocol/envelope.js").JsonObject;
        }[] = [];

        for (const spec of ranked.slice(0, limit)) {
            const mounted = bindingForSpec(spec, DEFAULT_MCP_CALL_TIMEOUT_MS, input.descriptionOverlay);
            if ("code" in mounted)
                continue;

            const item = { name: mounted.name, description: mounted.description, parameters: mounted.parameters };
            if (Buffer.byteLength(JSON.stringify([...result, item]), "utf8") > 48000) {
                if (result.length === 0)
                    return { outcome: "error", code: "mcp_schema_too_large", message: "The selected tool definition exceeds the discovery output limit." };
                break;
            }

            gate = applySearch(gate, query || String(server), [spec.qualifiedName]);
            const selected = applySchemaLoad(gate, spec.qualifiedName, digest(spec));
            if (!selected.ok)
                continue;

            gate = selected.value;
            loaded.set(spec.qualifiedName, { binding: mounted, spec, server: proxies.find(proxy => proxy.serverId === spec.serverId)! });
            liveNames.add(spec.qualifiedName);
            result.push(item);
        }

        const status = result.length ? "matched" : current.some(row => row.state === "ready") ? "no_match" : "unavailable";
        const value = { status, tools: result, servers: current.map(({ serverId, state, reason }) => ({ serverId, state, ...(reason ? { reason } : {}) })) };
        const instruction = status === "matched" ? "Call these exact tools through mcp_call_tool; existing permissions apply."
            : status === "no_match" ? "No matching schema was found among the ready servers. This does not mean those capabilities are unavailable; refine the query or select a server without a query."
                : "No selected configured server is ready. Inspect the returned server states and failure reasons.";
        return { outcome: "result", value, output: JSON.stringify({ ...value, instruction }), truncated: false };
    }

    const resources = createMcpResourcePort(proxies);

    for (const item of resources.snapshot())
        liveNames.add(item.name);

    return { tools: combineMcpToolPorts(tools, resources), toolNames: liveNames, servers: [], warnings,
        wrapProvider: provider => discoveryProvider(provider, canCall), close: () => client.close() };
}
