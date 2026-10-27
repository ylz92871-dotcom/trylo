import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type ProviderPort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolPort } from "../../ports/tools.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

test("a Work member keeps its action constraint through automatic parking and recovery", async t => {
  let effects = 0;
  let sequence = 0;
  const checked: string[] = [];
  const provider: ProviderPort = { async *stream(request) {
    let lastUser = request.messages.length - 1;
    while (lastUser >= 0 && request.messages[lastUser]?.role !== "user") lastUser -= 1;
    if (!request.messages.slice(lastUser + 1).some(message => message.role === "tool")) {
      yield { type: "tool_call", toolCallId: `write-${++sequence}`, name: "write_file",
        arguments: { path: "src/main.ts", content: "must not write" } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "The action was blocked." };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "usage", usage: emptyUsage() };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const tools: ToolPort = { snapshot: () => [{ name: "write_file", description: "write", sideEffect: "workspace_write",
    needsApproval: false, parameters: { type: "object" }, timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 100 } }],
    execute: async () => { effects += 1; return { outcome: "result", value: {}, output: "wrote", truncated: false }; },
    cancel: async () => {} };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, model: "test",
    callerMessages: undefined, permission: { request: async () => { throw new Error("no independent approval"); },
      awaitDecision: async () => { throw new Error("no independent approval"); } },
    team: { runId: "team-work", surface: "work", members: [{ memberId: "m-worker", baseRole: "worker", displayName: "writer",
      role: { name: "worker", description: "worker" } }],
      constrainTool: memberId => { checked.push(memberId); return { ok: false, code: "team_output_scope_denied", message: "Output scope denied" }; } } });
  t.after(async () => { await built.runtime.cancelAll(); });
  const call = (name: string, args: JsonObject) => built.tools.execute({ name, toolCallId: `${name}-${++sequence}`, arguments: args }, new AbortController().signal);
  const spawned = await call("spawn_agent", { agent_type: "worker", member_id: "m-worker", message: "write the proposed change" });
  assert.equal(spawned.outcome, "result");
  if (spawned.outcome !== "result") return;
  const task = String(spawned.value["task_id"] ?? spawned.value["agent_id"]);
  const first = await call("wait_agent", { targets: [task], timeout_ms: 1000, release_on_ready: true });
  assert.equal(first.outcome, "result");
  assert.equal(effects, 0);
  const sent = await call("send_input", { target: task, message: "try the same change again" });
  assert.equal(sent.outcome, "result");
  const previous = first.outcome === "result" ? (first.value["results"] as JsonObject)[task] as JsonObject : {};
  await call("wait_agent", { targets: [task], after: { [task]: previous["cursor"] ?? 0 }, timeout_ms: 1000, release_on_ready: true });
  assert.equal(effects, 0);
  assert.deepEqual(checked, ["m-worker", "m-worker"]);
});
