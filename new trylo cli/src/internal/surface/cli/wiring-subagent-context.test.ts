import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_PROFILE } from "../../contract/profile.js";
import { runTurn } from "../../loop/runner.js";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

test("fork_context uses the latest parent request and never a sibling child conversation", async t => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = {
    async *stream(request): AsyncIterable<ProviderEvent> {
      requests.push(request);
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "answer" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "usage", usage: emptyUsage() };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const tools: ToolPort = { snapshot: () => [],
    execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected tool" }), cancel: async () => {} };
  const permission = { request: async () => { throw new Error("unexpected approval"); },
    awaitDecision: async () => { throw new Error("unexpected approval"); } };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider,
    model: "test-model", permission, callerMessages: [{ role: "system", content: "project guidance" }] });
  t.after(async () => { await built.runtime.cancelAll(); });
  const parentTurn = (text: string) => runTurn({ provider: built.provider, tools: built.tools, permission,
    profile: { load: async () => EMPTY_PROFILE } }, { sessionId: "parent", turnId: text, correlationId: "root", text, model: "test-model" });
  let sequence = 0;
  const spawn = async (message: string): Promise<void> => {
    const outcome = await built.tools.execute({ toolCallId: `spawn-${++sequence}`, name: "spawn_agent",
      arguments: { message, fork_context: true } }, new AbortController().signal);
    assert.equal(outcome.outcome, "result");
    if (outcome.outcome !== "result") return;
    const id = String(outcome.value["agent_id"]);
    const ready = await built.tools.execute({ toolCallId: `wait-${sequence}`, name: "wait_agent",
      arguments: { targets: [id], timeout_ms: 1000 } }, new AbortController().signal);
    assert.equal(ready.outcome, "result");
    if (ready.outcome === "result") assert.equal((ready.value["results"] as JsonObject)[id] !== undefined, true);
  };
  await parentTurn("PARENT_FIRST_6721");
  await spawn("CHILD_PRIVATE_1928");
  const firstChild = requests.at(-1);
  assert.ok(firstChild?.messages.some(message => message.content === "PARENT_FIRST_6721"), "the current user message must reach the fork");
  assert.ok(!firstChild?.messages.some(message => message.role === "system" && message.content.startsWith("Available tools this run:")),
    "the parent's runtime tool list cannot become the child's tool list");
  assert.ok(firstChild?.messages.some(message => message.role === "system" && message.content.includes("You are a delegated subagent.")),
    "forked history must be distinguished from the child's assignment");
  await spawn("sibling");
  const sibling = requests.at(-1);
  assert.ok(sibling?.messages.some(message => message.content === "PARENT_FIRST_6721"));
  assert.ok(!sibling?.messages.some(message => message.content === "CHILD_PRIVATE_1928"), "child requests cannot replace the parent's fork source");
  await parentTurn("PARENT_LATEST_8841");
  await spawn("latest fork");
  assert.ok(requests.at(-1)?.messages.some(message => message.content === "PARENT_LATEST_8841"), "later parent requests refresh the fork source");
});
