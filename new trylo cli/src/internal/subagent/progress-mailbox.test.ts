import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderPort } from "../ports/provider.js";
import type { ToolOutcome } from "../ports/tools.js";
import { SubagentRuntime } from "./runtime.js";
import { createSubagentControlTool } from "./control-tools.js";
import { AgentRoundObservation } from "./control-observation.js";
import { createSubagentInputChannel } from "./input-channel.js";
import { emptyUsage } from "../ports/provider.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function value(outcome: ToolOutcome): JsonObject {
  assert.equal(outcome.outcome, "result");
  return outcome.outcome === "result" ? outcome.value : {};
}
function fixture(state: "progress" | "blocked" | "ready" = "blocked", response: "hold" | "answer" = "hold") {
  let begin!: () => void;
  const ready = new Promise<void>(resolve => { begin = resolve; });
  let requests = 0;
  const timers = new Set<() => void>();
  const provider: ProviderPort = { async *stream(_request, signal) {
    requests += 1;
    if (requests % 2 === 1) {
      await ready;
      yield { type: "tool_call", toolCallId: "blocked-1", name: "report_progress", arguments: {
        state, message: "导出入口已定位，需要确认允许修改的范围。" } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else if (response === "hold") {
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "完整技术答复" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  const control = createSubagentControlTool({ runtime, provider, scheduler: (_ms, fire) => {
    timers.add(fire); return { cancel: () => { timers.delete(fire); } };
  }, permission: { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } } });
  let calls = 0;
  const call = (name: string, args: JsonObject) => control.execute({ name, toolCallId: `parent-${++calls}`, arguments: args }, new AbortController().signal);
  return { runtime, call, begin, timers, requests: () => requests };
}

test("the parent can collect a blocked report while its real child is still working", async t => {
  const h = fixture(); t.after(() => h.runtime.cancelAll());
  const spawned = value(await h.call("spawn_agent", { message: "Inspect the export entry" }));
  const id = String(spawned["agent_id"]);
  h.begin(); await flush();
  const snapshot = value(await h.call("wait_agent", { targets: [id], timeout_ms: 0, wake_on_report: true }));
  const child = (snapshot["results"] as JsonObject)[id] as JsonObject;
  assert.equal(snapshot["timed_out"], false, "an authored blocker must be observable before the round ends");
  assert.equal(child["phase"], "working");
  assert.equal(child["status"], "running");
  assert.equal(child["output"], "");
  assert.deepEqual((child["reports"] as JsonObject[]).map(report => [report["state"], report["message"]]),
    [["blocked", "导出入口已定位，需要确认允许修改的范围。"]]);
  const next = value(await h.call("wait_agent", { targets: [id], timeout_ms: 0, wake_on_report: true, after: { [id]: child["cursor"]! } }));
  assert.equal(next["timed_out"], true);
  assert.deepEqual(((next["results"] as JsonObject)[id] as JsonObject)["reports"], []);
  assert.equal(h.requests(), 2, "collecting a report must not cause a summarizer or new execution request");
});

test("a subscribed wait wakes on a report without parking a working member", async t => {
  const h = fixture(); t.after(() => h.runtime.cancelAll());
  const id = String(value(await h.call("spawn_agent", { message: "Inspect" }))["agent_id"]);
  let answer: ToolOutcome | undefined;
  void h.call("wait_agent", { targets: [id], after: { [id]: 0 }, wake_on_report: true, release_on_ready: true }).then(result => { answer = result; });
  await flush(); assert.equal(answer, undefined);
  h.begin(); await flush();
  assert.ok(answer, "member reports must notify an already subscribed parent");
  assert.equal(value(answer)["timed_out"], false);
  assert.equal(h.runtime.status(id), "running", "release_on_ready cannot treat an authored blocker as a completed round");
  assert.equal(h.timers.size, 0, "the settled observation must release its deadline");
});

test("legacy waits keep waiting for the round while still returning reports in snapshots", async t => {
  const h = fixture(); t.after(() => h.runtime.cancelAll());
  const id = String(value(await h.call("spawn_agent", { message: "Inspect" }))["agent_id"]);
  h.begin(); await flush();
  const snapshot = value(await h.call("wait_agent", { targets: [id], timeout_ms: 0 }));
  assert.equal(snapshot["timed_out"], true);
  const child = (snapshot["results"] as JsonObject)[id] as JsonObject;
  assert.equal((child["reports"] as JsonObject[]).length, 1);
});

for (const state of ["progress", "ready"] as const) test(`${state} reports remain observations rather than ready rounds`, async t => {
  const h = fixture(state); t.after(() => h.runtime.cancelAll());
  const id = String(value(await h.call("spawn_agent", { message: "Inspect" }))["agent_id"]);
  h.begin(); await flush();
  const snapshot = value(await h.call("wait_agent", { targets: [id], timeout_ms: 0, wake_on_report: true, release_on_ready: true }));
  const child = (snapshot["results"] as JsonObject)[id] as JsonObject;
  assert.equal(snapshot["timed_out"], false);
  assert.equal(child["phase"], "working");
  assert.equal((child["reports"] as JsonObject[])[0]!["state"], state);
  assert.equal(h.runtime.status(id), "running");
});

test("report cursors cannot replay an already collected round answer", () => {
  const observation = new AgentRoundObservation(createSubagentInputChannel());
  observation.publish({ status: "completed", output: "已读的完整答案", rounds: 1, transcript: [], envelopes: [], usage: emptyUsage() });
  const after = observation.cursor;
  observation.publishProgress({ id: "note", kind: "report", round: 1, text: "补充风险，等待下一步。", reportState: "blocked" });
  assert.equal(observation.isReady(after), false);
  assert.equal(observation.hasReportAfter(after), true);
  assert.equal(observation.snapshot("running", after)["output"], "");
});

test("bounded reports expose only actual lost-report gaps and carry their cursors into a continuation", () => {
  const observation = new AgentRoundObservation(createSubagentInputChannel());
  observation.publish({ status: "completed", output: "answer", rounds: 1, transcript: [], envelopes: [], usage: emptyUsage() });
  for (let index = 1; index <= 16; index++) observation.publishProgress({ id: `report-${index}`, kind: "report", round: 1,
    reportState: "progress", text: `已检查第 ${index} 项。` });
  assert.equal(observation.snapshot("running", 0)["reports_truncated"], false);
  observation.publishProgress({ id: "report-17", kind: "report", round: 1, reportState: "blocked", text: "第17项需要澄清。" });
  assert.equal(observation.snapshot("running", 1)["reports_truncated"], true);
  assert.equal(observation.snapshot("running", 2)["reports_truncated"], false);
  assert.equal((observation.snapshot("running")["reports"] as JsonObject[]).length, 16);
  const next = new AgentRoundObservation(createSubagentInputChannel(), [], observation.cursor, undefined, observation.reportHistory);
  const after = next.cursor;
  next.publishProgress({ id: "report-18", kind: "report", round: 2, reportState: "ready", text: "准备进入独立验证。" });
  assert.equal(observation.cursor, after, "continuation must not mutate the previous execution's mailbox");
  assert.equal((next.snapshot("running", after)["reports"] as JsonObject[])[0]!["round"], 2);
  assert.equal(next.isReady(after), false);
});

test("real control continuation preserves report history and uses global rounds once", async t => {
  const h = fixture("progress", "answer"); t.after(() => h.runtime.cancelAll());
  const spawned = value(await h.call("spawn_agent", { message: "Inspect first" }));
  const task = String(spawned["task_id"]); const id = String(spawned["agent_id"]);
  h.begin(); await flush();
  const first = (value(await h.call("wait_agent", { targets: [task], timeout_ms: 0 }))["results"] as JsonObject)[task] as JsonObject;
  assert.equal(first["phase"], "awaiting_input");
  assert.equal((first["reports"] as JsonObject[])[0]!["round"], 1);
  await h.call("close_agent", { target: id }); await flush();
  const resumed = value(await h.call("resume_agent", { target: task, message: "Inspect next" }));
  assert.notEqual(resumed["agent_id"], id);
  await flush();
  const next = (value(await h.call("wait_agent", { targets: [task], timeout_ms: 0 }))["results"] as JsonObject)[task] as JsonObject;
  assert.deepEqual((next["reports"] as JsonObject[]).map(report => report["round"]), [1, 2]);
  const fresh = (value(await h.call("wait_agent", { targets: [task], timeout_ms: 0, after: { [task]: first["cursor"]! } }))["results"] as JsonObject)[task] as JsonObject;
  assert.deepEqual((fresh["reports"] as JsonObject[]).map(report => report["round"]), [2]);
});
