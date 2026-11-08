import type { JsonObject } from "../../protocol/envelope.js";
import type { McpServerEntry } from "../../ports/mcp-registry.js";
import type { McpClientOpen } from "./factory.js";
import { createClientForEntry } from "./factory.js";
import { openMcpPool, type McpPool, type McpRuntimeServer, type McpRuntimeCall } from "./pool.js";
import { digest, record, snapshotRegistry, type BrokerRow } from "./broker-contract.js";

type Connection = {
    readonly kind: "connecting";
    readonly pending: Promise<McpRuntimeServer | undefined>;
} | {
    readonly kind: "ready";
    readonly pool: McpPool;
    readonly server: McpRuntimeServer;
} | {
    readonly kind: "failed";
    readonly reason: string;
    readonly retryAt: number;
};

/** One connection owner per immutable workspace/configuration identity. */
export function createBrokerEngine(input: {
    readonly entries: readonly McpServerEntry[];
    readonly cwd: string;
    readonly clientFor?: (entry: McpServerEntry, cwd: string) => McpClientOpen;
    readonly now?: () => number;
}) {
    const now = input.now ?? Date.now;
    const states = new Map<string, Connection>();
    const entries = input.entries.filter(entry => entry.enabled);
    let closed = false;

    async function ensure(name: string): Promise<McpRuntimeServer | undefined> {
        if (closed || !entries.some(entry => entry.name === name))
            return undefined;

        const state = states.get(name);
        if (state?.kind === "ready")
            return state.server;

        if (state?.kind === "connecting")
            return state.pending;

        if (state?.kind === "failed" && state.retryAt > now())
            return undefined;

        // Concurrent callers share this connection attempt instead of spawning peers.
        const pending = (async () => {
            const pool = await openMcpPool({ registry: snapshotRegistry(entries.filter(entry => entry.name === name)),
                cwd: input.cwd, clientFor: input.clientFor ?? createClientForEntry });
            const server = pool.servers[0];
            if (closed || server === undefined) {
                await pool.closeAll();
                if (!closed)
                    states.set(name, { kind: "failed", reason: pool.failures[0]?.code ?? "unavailable", retryAt: now() + 30000 });
                return undefined;
            }

            states.set(name, { kind: "ready", pool, server });

            return server;
        })().catch(error => {
            // Adapter exceptions are explicit unavailability, never a detached rejection.
            if (!closed)
                states.set(name, { kind: "failed", reason: "adapter_exception", retryAt: now() + 30000 });
            void error;
            return undefined;
        });

        states.set(name, { kind: "connecting", pending });

        return pending;
    }

    function snapshot(): BrokerRow[] {
        return entries.map(entry => {
            const state = states.get(entry.name);
            return state?.kind === "ready" ? { serverId: entry.name, state: "ready", tools: state.server.tools }
                : state?.kind === "failed" ? { serverId: entry.name, state: "failed", tools: [], reason: state.reason }
                    : { serverId: entry.name, state: "connecting", tools: [] };
        });
    }

    async function call(name: string, tool: string, schemaHash: string, args: JsonObject, timeoutMs: number | undefined, signal: AbortSignal): Promise<McpRuntimeCall> {
        if (signal.aborted)
            return { ok: true, outcome: { outcome: "cancelled" } };

        const server = await ensure(name);
        const spec = server?.tools.find(item => item.serverToolName === tool);
        if (!server || !spec)
            return { ok: false, code: "mcp_unavailable", detail: "Search this server again; it is not available." };

        if (digest(spec) !== schemaHash)
            return { ok: false, code: "mcp_schema_changed", detail: "Tool definition changed; search and load it again." };

        const result = await server.call(tool, args, timeoutMs, signal);
        if (!result.ok && ["child_crashed", "not_initialized", "framing"].includes(result.code)) {
            const prior = states.get(name);
            states.set(name, { kind: "failed", reason: result.code, retryAt: now() + 30000 });
            if (prior?.kind === "ready")
                await prior.pool.closeAll();
        }

        return result; // Never replay an operation whose dispatch may have happened.
    }

    async function resource(raw: unknown, signal: AbortSignal): Promise<unknown> {
        if (!record(raw) || typeof raw.server !== "string")
            throw new Error("invalid_broker_resource");

        if (signal.aborted)
            return { ok: false, code: "cancelled", detail: "Resource request cancelled" };

        const server = await ensure(raw.server);
        if (!server)
            return { ok: false, code: "mcp_unavailable", detail: "MCP server unavailable" };

        if (signal.aborted)
            return { ok: false, code: "cancelled", detail: "Resource request cancelled" };

        const cursor = typeof raw.cursor === "string" ? raw.cursor : undefined;

        if (raw.operation === "list")
            return server.listResources(cursor, 10000);

        if (raw.operation === "templates")
            return server.listResourceTemplates(cursor, 10000);

        if (raw.operation === "read" && typeof raw.uri === "string")
            return server.readResource(raw.uri, undefined, signal);

        throw new Error("invalid_broker_resource");
    }

    return { snapshot, ensure, call, resource,
        async warm(): Promise<void> {
            const queue = entries.values();
            const worker = async () => {
                for (const entry of queue)
                    await ensure(entry.name);
            };
            await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
        },
        async close(): Promise<void> {
            // Close admission first; an in-flight connection will then close its own pool.
            closed = true;
            await Promise.all([...states.values()].map(async (state) => {
                if (state.kind === "connecting")
                    await state.pending;
                else if (state.kind === "ready")
                    await state.pool.closeAll();
            }));
            states.clear();
        },
    };
}
