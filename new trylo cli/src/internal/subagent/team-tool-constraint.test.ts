import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPermissionAction, createPermissionGrantCache } from "../loop/permission-grants.js";
import type { ToolPort } from "../ports/tools.js";
import { createSubagentToolBoundary } from "./lineage.js";

test("a frozen member constraint runs even when its parent already approved the exact action", async () => {
  let effects = 0;
  const call = { name: "write_file", toolCallId: "outside-work-output", arguments: { path: "src/main.ts", content: "wrong owner" } };
  const grants = createPermissionGrantCache();
  grants.record(buildPermissionAction(call.toolCallId, call.name, call.arguments), "approved", "session");
  const tools: ToolPort = { snapshot: () => [{ name: "write_file", description: "write", sideEffect: "workspace_write",
    needsApproval: true, parameters: {}, timeoutMs: 1000, outputLimits: { maxBytes: 100, maxLines: 10 } }],
    execute: async () => { effects += 1; return { outcome: "result", value: {}, output: "wrote", truncated: false }; },
    cancel: async () => {} };
  const boundary = createSubagentToolBoundary(tools, { allowedTools: ["write_file"], inheritedGrants: grants,
    constrainTool: () => ({ ok: false, code: "team_output_scope_denied", message: "Work output stays under .trylo/out" }) },
    { parentAgentId: "parent", rootAttemptId: "root" }, new AbortController().signal);
  const result = await boundary.execute(call, new AbortController().signal);
  assert.equal(result.outcome, "error");
  if (result.outcome === "error") assert.equal(result.code, "team_output_scope_denied");
  assert.equal(effects, 0);
});
