import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolOutcome, ToolPort } from "../../ports/tools.js";
import { buildSubagentPorts } from "./wiring-subagent.js";
import { createDenyAllPermission } from "./permission.js";

test("an older Person answer cannot admit a Worker while newer queued input is unrepresented", async t => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let announceFirst!: () => void;
  let announceSecond!: () => void;
  const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondRelease = new Promise<void>(resolve => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
  const secondStarted = new Promise<void>(resolve => { announceSecond = resolve; });
  let personRounds = 0;
  const provider: ProviderPort = { async *stream(request) {
    if (request.model === "person") {
      personRounds += 1;
      if (personRounds === 1) { announceFirst(); await firstRelease; }
      else { announceSecond(); await secondRelease; }
    }
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "clear" };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const tools: ToolPort = { snapshot: () => [], cancel: async () => {},
    execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }) };
  let attempt: Promise<ToolOutcome> | undefined;
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, model: "parent",
    callerMessages: undefined, permission: createDenyAllPermission(), onEvent: (kind, payload) => {
      if (attempt === undefined && kind === "subagent_update" && payload["agentType"] === "person"
        && payload["status"] === "waiting" && payload["round"] === 1) {
        attempt = call("spawn_agent", { agent_type: "worker", member_id: "m-worker", message: "must wait for latest input" });
      }
    }, team: { runId: "team-queued", inspectRepresentation: () => ({ ready: true }),
      members: ["person", "worker"].map(name => ({ memberId: `m-${name}`, baseRole: name, displayName: name,
        role: { name, model: name, description: name } })) } });
  t.after(async () => { releaseFirst(); releaseSecond(); await built.runtime.cancelAll(); });
  let sequence = 0;
  function call(name: string, args: JsonObject): Promise<ToolOutcome> {
    return built.tools.execute({ name, arguments: args, toolCallId: `parent-${++sequence}` }, new AbortController().signal);
  }
  const person = await call("spawn_agent", { agent_type: "person", member_id: "m-person", message: "original constraints" });
  assert.equal(person.outcome, "result");
  if (person.outcome !== "result") return;
  await firstStarted;
  assert.equal((await call("send_input", { target: person.value["task_id"] ?? "", message: "new constraints" })).outcome, "result");
  releaseFirst();
  await secondStarted;
  assert.ok(attempt);
  const refused = await attempt;
  assert.equal(refused.outcome === "error" ? refused.code : "", "team_representation_pending");
});

for (const operation of ["person-restart", "worker-stop"] as const) {
  test(`${operation} closes implementation admission before emitting cancellation`, async t => {
    const provider: ProviderPort = { async *stream() {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "clear" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };
    const tools: ToolPort = { snapshot: () => [], cancel: async () => {},
      execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }) };
    let cancelledId = "";
    let attempt: Promise<ToolOutcome> | undefined;
    const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider, model: "parent",
      callerMessages: undefined, permission: createDenyAllPermission(), onEvent: (kind, payload) => {
        if (attempt === undefined && kind === "subagent_end" && payload["subagentId"] === cancelledId && payload["status"] === "cancelled") {
          attempt = call("spawn_agent", { agent_type: "worker", member_id: "worker-b", message: "must wait for restarted Person" });
        }
      }, team: { runId: "team-restart-pending", inspectRepresentation: () => ({ ready: true }),
        members: ["person", "worker-a", "worker-b"].map(id => {
          const name = id === "person" ? "person" : "worker";
          return { memberId: id, baseRole: name, displayName: id, role: { name, model: name, description: name } };
        }) } });
    t.after(async () => { await built.runtime.cancelAll(); });
    let sequence = 0;
    function call(name: string, args: JsonObject): Promise<ToolOutcome> {
      return built.tools.execute({ name, arguments: args, toolCallId: `parent-${++sequence}` }, new AbortController().signal);
    }
    const person = await call("spawn_agent", { agent_type: "person", member_id: "person", message: "original constraints" });
    assert.equal(person.outcome, "result");
    if (person.outcome !== "result") return;
    const personId = String(person.value["agent_id"]);
    cancelledId = personId;
    await call("wait_agent", { targets: [personId], timeout_ms: 1000 });
    const first = await call("spawn_agent", { agent_type: "worker", member_id: "worker-a", message: "original implementation" });
    assert.equal(first.outcome, "result");
    if (first.outcome !== "result") return;
    await call("wait_agent", { targets: [first.value["task_id"] ?? ""], timeout_ms: 1000 });
    if (operation === "worker-stop") cancelledId = String(first.value["agent_id"]);
    const closed = operation === "worker-stop" ? await call("close_agent", { target: cancelledId, force: true })
      : await call("send_input", { target: personId, message: "new constraints", mode: "restart" });
    assert.equal(closed.outcome, "result");
    assert.ok(attempt, "observe cancellation before cleanup settlement");
    const refused = await attempt;
    assert.equal(refused.outcome === "error" ? refused.code : "", operation === "worker-stop" ? "agent_cleanup_pending" : "team_representation_pending");
  });
}
