import type { McpRegistryPort } from "../../ports/mcp-registry.js";
import { retainRuntimeView } from "./diagnostics.js";

/** Immutable run configuration wins by server id; management still writes the base registry. */
export function withRuntimeRegistry(base: McpRegistryPort, runtime: McpRegistryPort, mode: "overlay" | "exclusive"): McpRegistryPort {
  return {
    ...base,
    async names() {
      const supplied = await runtime.names();
      if (!supplied.ok || mode === "exclusive") return supplied;
      const original = await base.names();
      if (!original.ok) return supplied.value.length === 0 ? original : retainRuntimeView(supplied, original);
      const diagnostics = [...(original.diagnostics ?? []), ...(supplied.diagnostics ?? [])];
      return { ok: true, value: [...new Set([...original.value, ...supplied.value])].sort(),
        ...(diagnostics.length === 0 ? {} : { diagnostics }) };
    },
    async resolve(name) {
      const supplied = await runtime.names();
      if (!supplied.ok) return supplied;

      if (supplied.value.includes(name) || mode === "exclusive") {
        const result = await runtime.resolve(name);
        return result.ok ? { ...result, value: { ...result.value, scope: "project", shadowedScopes: [] } } : result;
      }

      return base.resolve(name);
    },
    async list() {
      const supplied = await runtime.list();
      if (!supplied.ok) return supplied;

      const servers = supplied.value.servers.map(entry => ({ ...entry, scopes: ["project" as const] }));

      if (mode === "exclusive") return { ...supplied, value: { ...supplied.value, servers } };

      const original = await base.list();
      if (!original.ok) return servers.length === 0 ? original : retainRuntimeView({ ...supplied, value: { ...supplied.value, servers } }, original);

      const merged = new Map(original.value.servers.map(entry => [entry.name, entry]));

      for (const entry of servers) merged.set(entry.name, entry);

      const diagnostics = [...(original.diagnostics ?? []), ...(supplied.diagnostics ?? [])];
      return { ok: true, value: { ...supplied.value, servers: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)) },
        ...(diagnostics.length === 0 ? {} : { diagnostics }) };
    },
  };
}
