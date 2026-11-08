import assert from "node:assert/strict";
import test from "node:test";
import type { McpRegistryDiagnostic, McpRegistryPort } from "../../ports/mcp-registry.js";
import { snapshotRegistry } from "../mcp-runtime/broker-contract.js";
import { withRuntimeRegistry } from "./runtime-overlay.js";

test("exclusive overlays preserve nested diagnostics on names, list and resolved runtime entries", async () => {
  const entry = { name: "trylo-browser", transport: "stdio" as const, command: "synthetic-browser", args: [], env: {}, enabled: true };
  const diagnostic: McpRegistryDiagnostic = { source: "base", coverage: "runtime_only", code: "invalid_document", detail: "internal-only failure" };
  const original = snapshotRegistry([entry]);
  const runtime: McpRegistryPort = {
    ...original,
    async names() { return { ok: true, value: [entry.name], diagnostics: [diagnostic] }; },
    async list() {
      return { ok: true, value: { formatVersion: 1, servers: [{ name: entry.name,
        transport: entry.transport, command: entry.command, args: [], envKeys: [], headerKeys: [], enabled: true,
        scopes: ["user"] }] }, diagnostics: [diagnostic] };
    },
    async resolve(name) {
      const result = await original.resolve(name);
      return result.ok ? { ...result, diagnostics: [diagnostic] } : result;
    },
  };
  const overlay = withRuntimeRegistry(snapshotRegistry([]), runtime, "exclusive");
  for (const result of [await overlay.names(), await overlay.list(), await overlay.resolve(entry.name)]) {
    assert.equal(result.ok, true);
    assert.deepEqual(Reflect.get(result, "diagnostics"), [diagnostic]);
  }
});
