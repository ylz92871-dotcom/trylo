import assert from "node:assert/strict";
import { test } from "node:test";
import { createCallCancellationRegistry } from "../adapters/tools/call-cancellation.js";
import type { ToolOutcome, ToolPort } from "../ports/tools.js";
import { SubagentRuntime } from "./runtime.js";
import { buildSubagentPorts } from "../surface/cli/wiring-subagent.js";

test("shared tool cancellation isolates parent and siblings that reuse a provider call id", async () => {
  const registry = createCallCancellationRegistry();
  const started: { owner: string; id: string }[] = [];
  const cancelled: string[] = [];
  const modelIds: string[] = [];
  const cleanup: (() => void)[] = [];
  let ready!: () => void;
  const allStarted = new Promise<void>(resolve => { ready = resolve; });
  const tools: ToolPort = { snapshot: () => [{ name: "read_file", description: "cancellable fixture", sideEffect: "read_only",
    needsApproval: false, parameters: {}, timeoutMs: 1000, outputLimits: { maxBytes: 100, maxLines: 10 } }],
    async execute(call) {
      const own = registry.begin(call.toolCallId);
      const owner = String(call.arguments.owner);
      started.push({ owner, id: call.toolCallId });
      if (started.length === 3) ready();
      try {
        return await new Promise<ToolOutcome>(resolve => {
          const finish = () => { resolve({ outcome: "cancelled" }); };
          own.signal.addEventListener("abort", () => { cancelled.push(owner); finish(); }, { once: true });
          cleanup.push(finish);
        });
      } finally { registry.end(call.toolCallId); }
    },
    async cancel(id) { registry.cancel(id); } };
  const call = (owner: string) => ({ name: "read_file", toolCallId: "call_1", arguments: { owner } });
  const parent = tools.execute(call("parent"), new AbortController().signal);
  const runtime = new SubagentRuntime({ tools });
  let cancelFirst!: () => Promise<void>;
  const handles = ["first", "second"].map(owner => runtime.spawn({ name: owner,
    permissions: { allowedTools: ["read_file"], constrainTool: request => { modelIds.push(request.toolCallId); return { ok: true }; } },
    lineage: { parentAgentId: "parent", rootAttemptId: owner },
    worker: context => {
      if (owner === "first") cancelFirst = () => context.tools.cancel("call_1");
      return context.tools.execute(call(owner), context.signal);
    } }));
  let actualCancelled: string[];
  try { await allStarted; await cancelFirst(); actualCancelled = [...cancelled]; }
  finally {
    for (const finish of cleanup) finish();
    await Promise.all([parent, ...handles.map(handle => handle.wait())]);
  }
  assert.deepEqual(actualCancelled, ["first"]);
  assert.equal(new Set(started.map(item => item.id)).size, 3);
  assert.deepEqual(modelIds, ["call_1", "call_1"]);
});

test("parent dispatch cannot impersonate a child internal call namespace", async () => {
  const seen: string[] = [];
  const tools: ToolPort = { snapshot: () => [{ name: "read_file", description: "inspection", sideEffect: "read_only",
    needsApproval: false, parameters: {}, timeoutMs: 1000, outputLimits: { maxBytes: 100, maxLines: 10 } }],
    execute: async call => { seen.push(call.toolCallId); return { outcome: "result", value: {}, output: "read", truncated: false }; },
    cancel: async () => {} };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools,
    childProvider: { async *stream() { yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } },
    model: "test", callerMessages: undefined, permission: {
      request: async () => { throw new Error("no approval"); }, awaitDecision: async () => { throw new Error("no approval"); } } });
  const childId = JSON.stringify(["subagent:fixed", "call_1"]);
  await built.tools.execute({ name: "read_file", toolCallId: childId, arguments: {} }, new AbortController().signal);
  assert.notEqual(seen[0], childId, "parent provider ids are wrapped in the parent namespace");
});
