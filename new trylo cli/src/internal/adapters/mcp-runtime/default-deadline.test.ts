import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingForSpec } from "./mount.js";
import { callTimeoutMs } from "./execute.js";

test("MCP tools have no invented execution deadline or two-minute ceiling", () => {
  const binding = bindingForSpec({ qualifiedName: "mcp__fixture__long", serverToolName: "long", serverId: "fixture",
    description: "Run the requested long operation.", inputSchema: { type: "object" }, annotations: {},
    annotationsTrust: "untrusted", needsApproval: true });

  assert.ok(!("code" in binding));

  if ("code" in binding) return;

  assert.equal(binding.timeoutMs, undefined);
  assert.equal(callTimeoutMs({ timeoutMs: 600_000 }, undefined), 600_000);
});
