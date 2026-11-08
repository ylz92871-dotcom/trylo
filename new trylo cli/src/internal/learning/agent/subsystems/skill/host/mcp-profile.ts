import type { McpRegistryPort, McpServerEntry } from "../../../../../ports/mcp-registry.js";
import type { HermesToolProfile } from "./client.js";

/** A private run profile; it never replaces the UI's stored MCP configuration. */
export function hermesProfileRegistry(profile: HermesToolProfile): McpRegistryPort {
  const entry: McpServerEntry = { name: profile.name, transport: "stdio", command: profile.command,
    args: profile.args, env: { ...profile.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, enabled: true };
  const frozen = () => ({ ok: false as const, code: "write_failed" as const, detail: "Hermes runtime profile is immutable" });

  return {
    add: async () => frozen(), remove: async () => frozen(), setEnabled: async () => frozen(),
    names: async () => ({ ok: true, value: [entry.name] }),
    resolve: async name => name === entry.name ? { ok: true, value: { entry, scope: "user", shadowedScopes: [] } }
      : { ok: false, code: "missing_entry", detail: "server is outside the Hermes runtime profile" },
    listScope: async scope => ({ ok: true, value: { scope, formatVersion: 1, servers: scope === "user" ? [entry] : [] } }),
    list: async () => ({ ok: true, value: { formatVersion: 1, servers: [{ name: entry.name, scopes: ["user"],
      transport: "stdio", command: entry.command, args: entry.args, envKeys: Object.keys(entry.env), headerKeys: [], enabled: true }] } }),
  };
}
