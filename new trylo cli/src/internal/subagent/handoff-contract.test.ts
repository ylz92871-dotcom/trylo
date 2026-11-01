import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function harness() {
  const requests: ProviderRequest[] = []; const events: Readonly<Record<string, unknown>>[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const provider: ProviderPort = { async *stream(request, signal) {
    requests.push(request);
    if (request.messages.some(message => message.content === "slow dependency")) {
      await Promise.race([gate, new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      })]);
    }
    yield { type: "text_start", blockId: "answer" }; yield { type: "text_delta", blockId: "answer", text: "实际答复" };
    yield { type: "text_end", blockId: "answer" }; yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    onEvent: (_kind, payload) => { events.push(payload); } });
  const tools = createSubagentControlTool({ runtime, provider, permission: {
    request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); },
  } });
  let id = 0;
  const call = (name: string, arguments_: JsonObject) => tools.execute({ name, toolCallId: `call-${++id}`, arguments: arguments_ }, new AbortController().signal);
  const spawn = async (message: string) => { const result = await call("spawn_agent", { message });
    assert.equal(result.outcome, "result"); return result.outcome === "result" ? String(result.value["task_id"]) : ""; };
  return { runtime, requests, events, release, call, spawn };
}

test("structured handoff reaches the member and distinguishes queued, started and answered facts", async t => {
  const h = harness(); t.after(() => h.runtime.cancelAll());
  const task = await h.spawn("first task"); await flush();
  const result = await h.call("send_input", { target: task, message: "独立核验", handoff: {
    scope: "核对中文文件名", artifacts: ["src/export.ts"], evidence: ["中文用例已通过"], pending: ["检查空格路径"], blockers: [],
  } });
  assert.equal(result.outcome, "result"); if (result.outcome !== "result") return;
  assert.equal(result.value["delivery"], "queued");
  const submissionId = result.value["submission_id"];
  await flush();
  assert.ok(h.requests.some(request => request.messages.some(message => message.content.includes("核对中文文件名") && message.content.includes("检查空格路径"))),
    "handoff fields must enter the actual recipient request");
  const delivery = h.events.map(event => event["delivery"]).filter(event => event && typeof event === "object" && !Array.isArray(event)) as JsonObject[];
  assert.deepEqual(delivery.filter(item => item["submissionId"] === submissionId).map(item => item["state"]), ["started", "answered"]);
  const observed = await h.call("wait_agent", { targets: [task], timeout_ms: 0 });
  assert.equal(observed.outcome, "result"); if (observed.outcome !== "result") return;
  const row = (observed.value["results"] as JsonObject)[task] as JsonObject;
  assert.equal((row["delivery"] as JsonObject)["state"], "answered");
});

test("unfinished dependencies refuse dispatch before another model is called", async t => {
  const h = harness(); t.after(() => h.runtime.cancelAll());
  const dependency = await h.spawn("slow dependency"); await flush();
  const blocked = await h.call("spawn_agent", { message: "requires previous output", depends_on: [dependency] });
  assert.equal(blocked.outcome, "error"); if (blocked.outcome === "error") assert.equal(blocked.code, "agent_dependency_pending");
  assert.equal(h.requests.length, 1);
  h.release(); await flush();
  const admitted = await h.call("spawn_agent", { message: "requires previous output", depends_on: [dependency] });
  assert.equal(admitted.outcome, "result");
});

test("unknown, self, failed and malformed dependencies cannot admit another execution", async t => {
  const h = harness(); t.after(() => h.runtime.cancelAll());
  const task = await h.spawn("existing"); await flush();
  for (const [name, args, code] of [
    ["spawn_agent", { message: "unknown", depends_on: ["missing"] }, "agent_dependency_unknown"],
    ["send_input", { target: task, message: "self", depends_on: [task] }, "agent_dependency_cycle"],
    ["spawn_agent", { message: "bad shape", depends_on: [7] }, "invalid_arguments"],
  ] as const) {
    const refused = await h.call(name, args);
    assert.equal(refused.outcome, "error"); if (refused.outcome === "error") assert.equal(refused.code, code);
  }
  await h.call("close_agent", { target: task, force: true });
  const refused = await h.call("spawn_agent", { message: "cancelled dependency", depends_on: [task] });
  assert.equal(refused.outcome, "error"); if (refused.outcome === "error") assert.equal(refused.code, "agent_dependency_failed");
  assert.equal(h.requests.length, 1);
});
