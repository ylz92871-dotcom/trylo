import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolOutcome, ToolPort } from "../../ports/tools.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { ProcessSessionSnapshot } from "../../ports/process-session.js";
import type { ProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { createDenyAllPermission } from "./permission.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

function value(result: ToolOutcome): JsonObject {
  assert.equal(result.outcome, "result");
  return result.outcome === "result" ? result.value : {};
}
for (const verdict of ["clear", "held"] as const) {
  test(`a ${verdict} Person result preserves unconfirmed Worker cleanup as a separate implementation hold`, async t => {
    const rows: ProcessSessionSnapshot[] = [];
    const sessions: ProcessSessionRegistry = { maxSessions: 4, list: () => ({ sessions: rows }),
      get: id => rows.find(row => row.id === id), shutdown: async () => {},
      start: async () => { throw new Error("unexpected start"); }, write: async () => { throw new Error("unexpected input"); },
      stop: async () => ({ ok: false, code: "session_stop_failed", message: "injected native refusal" }) };
    const tools: ToolPort = { snapshot: () => [], cancel: async () => {},
      execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }) };
    let personRounds = 0;
    const provider: ProviderPort = { async *stream(request) {
      const output = request.model === "person" && ++personRounds > 1 ? verdict : "clear";
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: output };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };
    const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, sessions, childProvider: provider,
      model: "parent", callerMessages: undefined, permission: createDenyAllPermission(),
      team: { runId: "team-cleanup", inspectRepresentation: output => output === "clear" ? { ready: true }
        : { ready: false, reason: "Person veto" }, members: ["person", "worker-a", "worker-b"].map(id => {
        const role = id === "person" ? "person" : "worker";
        return { memberId: id, baseRole: role, displayName: id, role: { name: role, model: role, description: role } };
      }) } });
    t.after(async () => { await built.runtime.cancelAll(); });
    let sequence = 0;
    const call = (name: string, args: JsonObject) => built.tools.execute({ name, arguments: args,
      toolCallId: `parent-${++sequence}` }, new AbortController().signal);
    const person = String(value(await call("spawn_agent", { agent_type: "person", member_id: "person", message: "represent" }))["task_id"]);
    const first = value(await call("wait_agent", { targets: [person], timeout_ms: 1000 }));
    const worker = String(value(await call("spawn_agent", { agent_type: "worker", member_id: "worker-a", message: "implement" }))["task_id"]);
    await call("wait_agent", { targets: [worker], timeout_ms: 1000 });
    rows.push({ id: "ps_000000000000000000000001", ownerId: worker, status: "running", command: "test", cwd: ".", tty: false,
      bufferedBytes: 0, droppedOutput: false, startedAtMs: 0 });
    await call("send_input", { target: person, message: "new constraints" });
    const prior = (first["results"] as JsonObject)[person] as JsonObject;
    const answer = value(await call("wait_agent", { targets: [person], timeout_ms: 1000, after: { [person]: prior["cursor"] ?? 0 } }));
    assert.equal(((answer["results"] as JsonObject)[person] as JsonObject)["output"], verdict);
    assert.equal((await call("close_agent", { target: worker, force: true })).outcome, "error");
    const next = await call("spawn_agent", { agent_type: "worker", member_id: "worker-b", message: "do not overlap" });
    assert.equal(next.outcome === "error" ? next.code : "", verdict === "clear" ? "agent_cleanup_failed" : "team_representation_held");
    const report = value(await call("wait_agent", { targets: [worker], timeout_ms: 0 }));
    assert.equal((((report["results"] as JsonObject)[worker] as JsonObject)["cleanup"] as JsonObject)["status"], "failed");
  });
}
