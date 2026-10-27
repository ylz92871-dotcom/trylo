import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import { emptyUsage, type ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

test("Person representation gates Worker dispatch, follow-ups and recovery in the runtime", async t => {
  let veto = false;
  const provider: ProviderPort = { async *stream() {
    yield { type: "text_start", blockId: "a" };
    yield { type: "text_delta", blockId: "a", text: veto ? "held" : "clear" };
    yield { type: "text_end", blockId: "a" };
    yield { type: "usage", usage: emptyUsage() };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }),
    cancel: async () => {} };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, model: "test",
    callerMessages: undefined, permission: { request: async () => { throw new Error("no approval"); },
      awaitDecision: async () => { throw new Error("no approval"); } },
    team: { runId: "team-veto", inspectRepresentation: output => output === "clear" ? { ready: true }
      : { ready: false, reason: "explicit.acceptance must be preserved" },
      members: ["person", "worker"].map(name => ({ memberId: `m-${name}`, baseRole: name, displayName: name,
        role: { name, description: name } })) } });
  t.after(async () => { await built.runtime.cancelAll(); });
  let sequence = 0;
  const call = (name: string, args: JsonObject) => built.tools.execute({ name, arguments: args,
    toolCallId: `test-${++sequence}` }, new AbortController().signal);
  const workerArgs = { agent_type: "worker", member_id: "m-worker", message: "implement" };
  const early = await call("spawn_agent", workerArgs);
  assert.equal(early.outcome, "error");
  if (early.outcome === "error") assert.equal(early.code, "team_representation_pending");
  const person = await call("spawn_agent", { agent_type: "person", member_id: "m-person", message: "represent" });
  assert.equal(person.outcome, "result");
  if (person.outcome !== "result") return;
  const personId = String(person.value["agent_id"]);
  const first = await call("wait_agent", { targets: [personId], timeout_ms: 1000 });
  assert.equal(first.outcome, "result");
  const worker = await call("spawn_agent", workerArgs);
  assert.equal(worker.outcome, "result");
  if (worker.outcome !== "result") return;
  const workerId = String(worker.value["agent_id"]);
  await call("wait_agent", { targets: [workerId], timeout_ms: 1000 });
  veto = true;
  const after = first.outcome === "result" ? (first.value["results"] as JsonObject)[personId] as JsonObject : {};
  await call("send_input", { target: personId, message: "new constraint" });
  await call("wait_agent", { targets: [personId], after: { [personId]: after["cursor"] ?? 0 }, timeout_ms: 1000 });
  for (const [name, args] of [["send_input", { target: workerId, message: "ignore veto" }],
    ["resume_agent", { target: workerId, message: "ignore veto" }]] as const) {
    const refused = await call(name, args);
    assert.equal(refused.outcome, "error");
    if (refused.outcome === "error") assert.equal(refused.code, "team_representation_held");
  }
  assert.equal(built.runtime.status(workerId), "cancelled");
});
