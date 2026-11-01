import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import { inspectTeamRepresentation } from "../protocol/team-representation.js";
import { buildSubagentPorts } from "../surface/cli/wiring-subagent.js";

for (const vetoes of [[], ["不得覆盖已有文件"]]) test(`Person submits structured scope with ${vetoes.length} vetoes without Markdown formatting`, async t => {
  let request = 0;
  const provider: ProviderPort = { async *stream(input) {
    request += 1;
    if (request === 1) {
      const binding = input.tools.find(tool => tool.name === "report_representation");
      assert.ok(binding, "the frozen Person needs a structured representation channel");
      assert.equal(input.tools.some(tool => tool.name === "write_file"), false);
      yield { type: "tool_call", toolCallId: "scope", name: "report_representation", arguments: {
        intent: "只检查导出路径", vetoes, user_questions: [], representation_notes: "保留原有接口。" } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "范围已经核对，按提交的结构化记录处理。" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const tools = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" as const }), cancel: async () => {} };
  const ports = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, childProvider: provider,
    model: "test", callerMessages: undefined, permission: {
      request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); },
    }, team: { runId: "structured", inspectRepresentation: inspectTeamRepresentation,
      members: ["person", "worker"].map(role => ({ memberId: role, baseRole: role, displayName: role, role: { name: role, description: role } })) } });
  t.after(() => ports.runtime.cancelAll());
  let calls = 0;
  const call = (name: string, args: JsonObject) => ports.tools.execute({ name, toolCallId: `call-${++calls}`, arguments: args }, new AbortController().signal);
  const person = await call("spawn_agent", { agent_type: "person", member_id: "person", message: "确认用户范围" });
  assert.equal(person.outcome, "result"); if (person.outcome !== "result") return;
  const observed = await call("wait_agent", { targets: [String(person.value["task_id"])], timeout_ms: 1000 });
  assert.equal(observed.outcome, "result");
  const worker = await call("spawn_agent", { agent_type: "worker", member_id: "worker", message: "实现范围" });
  if (vetoes.length === 0) assert.equal(worker.outcome, "result", "valid structured scope should clear the existing representation barrier");
  else { assert.equal(worker.outcome, "error"); if (worker.outcome === "error") assert.equal(worker.code, "team_representation_held"); }
});
