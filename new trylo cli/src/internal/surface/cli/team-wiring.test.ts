import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

test("a frozen team member consumes its own model, prompt and tool ceiling", async t => {
  const requests: ProviderRequest[] = [];
  const events: Array<Record<string, unknown>> = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "text_start", blockId: "a" };
    yield { type: "text_delta", blockId: "a", text: "reviewed" };
    yield { type: "text_end", blockId: "a" };
    yield { type: "usage", usage: emptyUsage() };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const tools: ToolPort = { snapshot: () => ["read_file", "write_file"].map(name => ({
    name, description: name, sideEffect: name === "read_file" ? "read_only" : "workspace_write",
    needsApproval: false, timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 100 },
    parameters: { type: "object", properties: {} },
  })), execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }), cancel: async () => {} };
  const options = { parentTools: tools, workspaceTools: tools, childProvider: provider, model: "parent-model",
    callerMessages: undefined,
    permission: { request: async () => { throw new Error("no independent approval"); },
      awaitDecision: async () => { throw new Error("no independent approval"); } },
    onEvent: (_kind: string, payload: object) => { events.push({ ...payload }); },
    team: { runId: "team-1", members: [{ memberId: "m2", baseRole: "reviewer", displayName: "Second reviewer",
      role: { name: "reviewer", description: "review", model: "member-model", prompt: "MEMBER_INSTRUCTION",
        allowedTools: ["read_file", "write_file"] } }] },
  };
  const built = buildSubagentPorts(options);
  t.after(async () => { await built.runtime.cancelAll(); });
  await t.test("anonymous delegation is absent and the late-bound skill exit refuses a team bypass", async () => {
    assert.equal(built.tools.snapshot().some(tool => tool.name === "delegate_subagent"), false);
    const bypass = await built.toolPort.execute({ name: "delegate_subagent", toolCallId: "bypass",
      arguments: { taskName: "outsider", prompt: "do work" } }, new AbortController().signal);
    assert.equal(bypass.outcome, "error");
    if (bypass.outcome === "error") assert.equal(bypass.code, "team_member_identity_required");
  });
  const spawn = await built.tools.execute({ name: "spawn_agent", toolCallId: "s", arguments: {
    agent_type: "reviewer", member_id: "m2", message: "review this" } }, new AbortController().signal);
  assert.equal(spawn.outcome, "result");
  if (spawn.outcome !== "result") return;
  const id = String(spawn.value["agent_id"]);
  await built.tools.execute({ name: "wait_agent", toolCallId: "w", arguments: { targets: [id], timeout_ms: 1000 } }, new AbortController().signal);
  assert.deepEqual(spawn.value["allowed_tools"], ["read_file"]);
  assert.equal(requests[0]?.model, "member-model");
  assert.ok(requests[0]?.messages.some(message => message.content.includes("MEMBER_INSTRUCTION")));
  assert.ok(events.some(event => event.teamRunId === "team-1" && event.memberId === "m2"));
  const duplicate = await built.tools.execute({ name: "spawn_agent", toolCallId: "s2", arguments: {
    agent_type: "reviewer", member_id: "m2", message: "duplicate" } }, new AbortController().signal);
  assert.equal(duplicate.outcome, "error");
  const mismatched = await built.tools.execute({ name: "spawn_agent", toolCallId: "s3", arguments: {
    agent_type: "worker", member_id: "m2", message: "wrong role" } }, new AbortController().signal);
  assert.equal(mismatched.outcome, "error");
});
