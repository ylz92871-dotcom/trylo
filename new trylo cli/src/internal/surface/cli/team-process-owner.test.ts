import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import { emptyUsage, type ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

test("host ownership follows the logical task through recovery and cannot be supplied by a parent call", async t => {
  let sequence = 0;
  const owners: unknown[] = [];
  const provider: ProviderPort = { async *stream(request) {
    let user = request.messages.length - 1;
    while (user >= 0 && request.messages[user]?.role !== "user") user -= 1;
    if (!request.messages.slice(user + 1).some(message => message.role === "tool")) {
      yield { type: "tool_call", toolCallId: `read-${++sequence}`, name: "read_file", arguments: { path: "anchor.txt" } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "Observed." };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "usage", usage: emptyUsage() };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const tools: ToolPort = { snapshot: () => [{ name: "read_file", description: "read", sideEffect: "read_only", needsApproval: false,
    parameters: {}, timeoutMs: 1000, outputLimits: { maxBytes: 100, maxLines: 10 } }],
    execute: async call => { owners.push("ownerId" in call ? call.ownerId : undefined);
      return { outcome: "result", value: {}, output: "anchor", truncated: false }; }, cancel: async () => {} };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, model: "test",
    callerMessages: undefined, permission: { request: async () => { throw new Error("no independent approval"); },
      awaitDecision: async () => { throw new Error("no independent approval"); } },
    team: { runId: "owned-team", members: ["first", "second"].map(memberId => ({ memberId, baseRole: "worker",
      displayName: memberId, role: { name: "worker", description: "worker" } })) } });
  t.after(async () => { await built.runtime.cancelAll(); });
  const signal = new AbortController().signal;
  const call = (name: string, args: JsonObject) => built.tools.execute({ name, arguments: args, toolCallId: `parent-${++sequence}` }, signal);
  const spoofed = { name: "read_file", toolCallId: "root", arguments: {}, ownerId: "forged-task" };
  await built.tools.execute(spoofed, signal);
  const first = await call("spawn_agent", { agent_type: "worker", member_id: "first", message: "inspect" });
  assert.equal(first.outcome, "result");
  if (first.outcome !== "result") return;
  const task = String(first.value.task_id);
  const report = await call("wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
  assert.equal(report.outcome, "result");
  const sent = await call("send_input", { target: task, message: "inspect again" });
  assert.equal(sent.outcome, "result");
  const prior = report.outcome === "result" ? (report.value.results as JsonObject)[task] as JsonObject : {};
  await call("wait_agent", { targets: [task], after: { [task]: prior.cursor ?? 0 }, timeout_ms: 1000, release_on_ready: true });
  const sibling = await call("spawn_agent", { agent_type: "worker", member_id: "second", message: "inspect independently" });
  assert.equal(sibling.outcome, "result");
  if (sibling.outcome !== "result") return;
  await call("wait_agent", { targets: [String(sibling.value.task_id)], timeout_ms: 1000, release_on_ready: true });
  assert.deepEqual(owners, [undefined, task, task, String(sibling.value.task_id)]);
});
