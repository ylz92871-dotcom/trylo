import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { buildPermissionAction, createPermissionGrantCache } from "../../loop/permission-grants.js";
import type { ToolOutcome } from "../../ports/tools.js";
import { SubagentRuntime } from "../../subagent/runtime.js";

test("a recovered member controls its real background command while a sibling cannot", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-member-command-"));
  const sessions = createProcessSessionRegistry();
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }), sessions });
  const runtime = new SubagentRuntime({ tools });
  t.after(async () => { await runtime.cancelAll(); await sessions.shutdown(); });
  const signal = new AbortController().signal;
  const call = { name: "run_shell", toolCallId: "call_1", arguments: {
    command: `node -e ${JSON.stringify("console.log('MEMBER_READY'); setInterval(()=>{},1000)")}`, runInBackground: true } };
  const grants = createPermissionGrantCache();
  grants.record(buildPermissionAction(call.toolCallId, call.name, call.arguments), "approved", "session");
  const first = runtime.spawn<ToolOutcome>({ name: "first", permissions: { allowedTools: ["run_shell"], inheritedGrants: grants },
    lineage: { parentAgentId: "parent", rootAttemptId: "member-start" }, worker: context => context.tools.execute(call, context.signal) });
  const started = await first.wait();
  assert.equal(started.status, "completed");
  assert.equal(started.output?.outcome, "result");
  if (started.output?.outcome !== "result") return;
  await runtime.waitForRetirement(first.subagentId, 1000, signal);
  const id = String(started.output.value.sessionId);
  assert.equal(sessions.get(id)?.ownerId, first.subagentId);
  const stranger = runtime.spawn<ToolOutcome>({ name: "sibling", permissions: { allowedTools: ["stop_process"] },
    lineage: { parentAgentId: "parent", rootAttemptId: "sibling-stop" }, worker: context => context.tools.execute({
      name: "stop_process", toolCallId: "call_1", arguments: { sessionId: id } }, context.signal) });
  assert.equal((await stranger.wait()).output?.outcome, "error");
  assert.equal(sessions.get(id)?.status, "running");
  const continued = runtime.spawn<ToolOutcome>({ name: "continued", permissions: { allowedTools: ["write_stdin", "stop_process"] },
    continuation: { taskId: first.subagentId, resumedFrom: first.subagentId, roundOffset: 1 },
    lineage: { parentAgentId: "parent", rootAttemptId: "member-continue" }, worker: async context => {
      const read = await context.tools.execute({ name: "write_stdin", toolCallId: "read", arguments: { sessionId: id, yieldMs: 1000 } }, context.signal);
      assert.equal(read.outcome, "result");
      if (read.outcome === "result") assert.match(read.output, /MEMBER_READY/);
      return context.tools.execute({ name: "stop_process", toolCallId: "stop", arguments: { sessionId: id } }, context.signal);
    } });
  const finished = await continued.wait();
  assert.equal(finished.status, "completed");
  assert.equal(finished.output?.outcome, "result");
  assert.equal(sessions.get(id)?.status, "exited");
  assert.equal(sessions.get(id)?.ownerId, first.subagentId);
});
