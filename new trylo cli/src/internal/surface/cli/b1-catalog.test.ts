import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolBinding, ToolPort } from "../../ports/tools.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { b1CompatibleCatalogHashes, toolCatalogHash } from "./wiring-catalog.js";

const asTools = (bindings: ReadonlyArray<ToolBinding>): ToolPort => ({ snapshot: () => bindings, execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} });

test("B1 compatibility projects exactly its optional arguments and preserves unrelated tools", () => {
  const tools = createWorkspaceTools({ workspaceRoot: "/project", sandbox: createWorkspaceSandbox({ workspaceRoot: "/project" }) });
  const old = tools.snapshot().map(binding => {
    const added = binding.name === "read_file" ? ["offset", "limit"] : binding.name === "search_text" || binding.name === "glob_files" ? ["include", "exclude"] : [];
    const properties = binding.parameters.properties as JsonObject | undefined;
    return properties === undefined ? binding : { ...binding, parameters: { ...binding.parameters,
      properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !added.includes(name))),
    } };
  });
  const historical = toolCatalogHash(asTools(old));

  assert.ok(b1CompatibleCatalogHashes(tools).includes(historical));
  assert.notEqual(historical, toolCatalogHash(tools));
  const mcp: ToolBinding = { name: "mcp_changed", description: "external", sideEffect: "external", needsApproval: true, timeoutMs: 1, outputLimits: { maxBytes: 1, maxLines: 1 }, parameters: { type: "object", properties: { host: { type: "string" } } } };

  assert.equal(b1CompatibleCatalogHashes(asTools([...tools.snapshot(), mcp])).includes(historical), false);
});
