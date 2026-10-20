import assert from "node:assert/strict";
import { test } from "node:test";
import { admitToolCall } from "./tool-admission.js";
import { createDoomLoopTracker } from "./doom-loop.js";
import { createPermissionGrantCache, buildPermissionAction } from "./permission-grants.js";
import type { PermissionPort } from "../ports/permission.js";
import { readToolApprovalRequirement } from "./tool-boundary.js";
import type { ToolBinding } from "../ports/tools.js";

test("an explicit tool denial outranks remembered grants and automatic allow decisions", async () => {
  const call = { toolCallId: "write", name: "write_file", arguments: { path: "result.txt", content: "data" } };
  const grants = createPermissionGrantCache(); grants.record(buildPermissionAction(call.toolCallId, call.name, call.arguments), "approved", "session");
  const permission: PermissionPort = { isDenied: () => true,
    async request() { throw new Error("denied policy cannot prompt"); }, async awaitDecision() { throw new Error("denied policy cannot prompt"); } };
  for (const execPolicy of [undefined, () => ({ kind: "approved" as const })]) {
    const result = await admitToolCall({ permission, grants, doom: createDoomLoopTracker(), ...(execPolicy === undefined ? {} : { execPolicy }) }, call);
    assert.deepEqual(result, { kind: "denied", source: "policy", reason: "policy_denied" });
  }
  const binding: ToolBinding = { name: "read_file", description: "read", parameters: {}, sideEffect: "read_only", needsApproval: false,
    timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } };
  assert.equal(readToolApprovalRequirement({ snapshot: () => [binding], async execute() { throw new Error("unused"); }, async cancel() {} }, binding.name,
    undefined, undefined, permission).required, true, "read-only calls also reach the standing denial");
});
