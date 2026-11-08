import { createHash } from "node:crypto";
import type { JsonObject } from "../../protocol/envelope.js";
import type { McpToolSpec } from "../../ports/mcp-client.js";
import type { McpRegistryPort, McpServerEntry } from "../../ports/mcp-registry.js";
import { validateEntryShape } from "../mcp-registry/validate.js";
import { qualifyMcpToolName } from "../../mcp/names.js";

export const BROKER_VERSION = 1;
export const BROKER_IDLE_MS = 5 * 60000;

export type BrokerConfig = {
    readonly version: 1;
    readonly key: string;
    readonly cwd: string;
    readonly entries: readonly McpServerEntry[];
};

export type BrokerAddress = {
    readonly version: 1;
    readonly key: string;
    readonly port: number;
    readonly token: string;
};

export type BrokerRow = {
    readonly serverId: string;
    readonly state: "connecting" | "ready" | "failed";
    readonly tools: readonly McpToolSpec[];
    readonly reason?: string;
};

export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function object(value: unknown): value is JsonObject { return record(value); }

export function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function isEntry(value: unknown): value is McpServerEntry {
    return record(value) && validateEntryShape({ name: value.name, transport: value.transport, command: value.command,
        args: value.args, env: value.env, enabled: value.enabled, url: value.url, headers: value.headers }) === undefined;
}

export function isSpec(value: unknown): value is McpToolSpec {
    if (!record(value) || typeof value.serverId !== "string" || typeof value.serverToolName !== "string")
        return false;
    const name = qualifyMcpToolName(value.serverId, value.serverToolName);
    return name.ok && value.qualifiedName === name.value && typeof value.description === "string" && object(value.inputSchema)
        && object(value.annotations) && value.annotationsTrust === "untrusted" && value.needsApproval === true;
}

export function isRow(value: unknown): value is BrokerRow {
    return record(value) && typeof value.serverId === "string" && ["connecting", "ready", "failed"].includes(String(value.state))
        && Array.isArray(value.tools) && value.tools.every(isSpec) && (value.reason === undefined || typeof value.reason === "string");
}

export function isAddress(value: unknown): value is BrokerAddress {
    return record(value) && value.version === BROKER_VERSION && typeof value.key === "string" && typeof value.token === "string"
        && /^[A-Za-z0-9_-]{43}$/.test(value.token) && Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) < 65536;
}

/** Immutable run configuration, not another writable MCP registry. */
export function snapshotRegistry(entries: readonly McpServerEntry[]): McpRegistryPort {
    const refused = { ok: false as const, code: "write_failed" as const, detail: "runtime configuration is read-only" };
    return { add: async () => refused, remove: async () => refused, setEnabled: async () => refused,
        list: async () => refused, listScope: async () => refused,
        names: async () => ({ ok: true, value: entries.map(entry => entry.name) }),
        resolve: async (name) => {
            const entry = entries.find(item => item.name === name);
            return entry ? { ok: true, value: { entry, scope: "user", shadowedScopes: [] } } : { ok: false, code: "missing_entry", detail: name };
        } };
}
