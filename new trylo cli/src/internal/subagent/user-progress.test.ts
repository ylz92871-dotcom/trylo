import assert from "node:assert/strict";
import { test } from "node:test";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import { emptyUsage, type ProviderPort } from "../ports/provider.js";
import { withMemberReporting } from "./user-progress.js";
import { createSubagentObserver, isSubagentObservation, type SubagentObservation } from "../protocol/subagent-observation.js";
import type { Envelope } from "../protocol/envelope.js";
import { projectEnvelopeSequence } from "../surface/cli/stream-projection.js";

test("children receive a dedicated progress channel without gaining execution tools", async () => {
  const provider: ProviderPort = { async *stream(request) {
    assert.ok(request.tools.some(tool => tool.name === "report_progress"), "missing member reporting channel");
    assert.ok(request.messages.some(message => JSON.stringify(message).includes("report_progress")));
    assert.equal(request.tools.some(tool => tool.name === "write_file"), false);
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "Original detailed answer" };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "usage", usage: emptyUsage() };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const worker = createInteractiveChildWorker({ provider, permission: { request: async () => { throw new Error("no approval expected"); }, awaitDecision: async () => { throw new Error("no decision expected"); } }, message: "Read only" });
  await worker({ subagentId: "child", name: "child", lineage: { parentAgentId: "main", rootAttemptId: "root" },
    signal: new AbortController().signal, tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    reportProgress: () => {}, recordUsage: () => {} });
});

test("reports publish concise authored observations and never forward execution", async () => {
  const reports: SubagentObservation[] = [];
  const tools = withMemberReporting({ snapshot: () => [], execute: async () => { throw new Error("must not execute"); }, cancel: async () => {} }, event => reports.push(event), () => 2);
  const call = { name: "report_progress", toolCallId: "report-2", arguments: { state: "blocked", message: "读取失败，需要核对路径。" } };
  assert.equal((await tools.execute(call, new AbortController().signal)).outcome, "result");
  assert.deepEqual(reports, [{ id: "report-2", round: 2, kind: "report", reportState: "blocked", text: "读取失败，需要核对路径。" }]);
  assert.equal((await tools.execute({ ...call, arguments: { state: "ready", message: "x".repeat(1201) } }, new AbortController().signal)).outcome, "error");
  const cancel = new AbortController(); cancel.abort();
  assert.equal((await tools.execute(call, cancel.signal)).outcome, "cancelled");
  assert.equal(reports.length, 1);
});

test("the actual child loop publishes a report without an approval or extra summarizer", async () => {
  const observations: SubagentObservation[] = [];
  let requests = 0;
  const provider: ProviderPort = { async *stream() {
    requests += 1;
    if (requests === 1) {
      yield { type: "tool_call", toolCallId: "report", name: "report_progress", arguments: { state: "progress", message: "正在核对导出入口，随后验证中文路径。" } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "Full internal answer" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const worker = createInteractiveChildWorker({ provider, message: "Inspect entry", permission: {
    request: async () => { throw new Error("reporting must not need approval"); }, awaitDecision: async () => { throw new Error("unexpected decision"); },
  } });
  const result = await worker({ subagentId: "child", name: "child", lineage: { parentAgentId: "main", rootAttemptId: "root" },
    signal: new AbortController().signal, tools: { snapshot: () => [], execute: async () => { throw new Error("no execution tool"); }, cancel: async () => {} },
    reportProgress: () => {}, recordUsage: () => {}, reportObservation: event => observations.push(event) });
  assert.equal(requests, 2);
  assert.equal(result.output, "Full internal answer");
  assert.equal(observations.filter(event => event.kind === "report").length, 1);
  assert.ok(observations.some(event => event.kind === "text" && event.text === "Full internal answer"));
});

test("member transcript preserves chronology without emitting redacted thinking", () => {
  const events: SubagentObservation[] = [];
  const observe = createSubagentObserver(event => events.push(event));
  let sequence = 0;
  const envelope = (kind: string, payload: Envelope['payload']): Envelope => ({ protocolVersion: "0.0", eventId: `e${++sequence}`, sequence,
    timestamp: "2026-10-27T00:00:00Z", kind, payload, producerId: "loop", producerSequence: sequence });
  observe(envelope("text", { text: "先读取" }), 1);
  observe(envelope("text", { text: "入口文件。" }), 1);
  observe(envelope("thinking", { text: "redacted secret", redacted: true }), 1);
  observe(envelope("tool_use", { toolCallId: "read", name: "read_file", arguments: { path: "入口.ts" } }), 1);
  observe(envelope("tool_result", { toolCallId: "read", name: "read_file", status: "failed", message: "not found" }), 1);
  observe(envelope("text", { text: "路径不存在。" }), 1);
  assert.equal(events[1]?.text, "先读取入口文件。");
  assert.equal(events.some(event => event.text?.includes("secret")), false);
  assert.deepEqual(events.slice(2).map(event => event.kind), ["tool", "result", "text"]);
  assert.equal(events[3]?.ok, false);
  assert.ok(events.every(isSubagentObservation));
  assert.equal(isSubagentObservation({ id: "bad", kind: "report", round: 1, reportState: "done", text: "false success" }), false);
});

test("authored reports survive CLI wire projection without changing execution status", () => {
  const observation = { id: "report", kind: "report" as const, round: 1, reportState: "ready" as const, text: "实现已交付，等待独立验证。" };
  const events = projectEnvelopeSequence([{ protocolVersion: "0.0", eventId: "update", sequence: 1,
    timestamp: "2026-10-27T00:00:00Z", kind: "subagent_update", producerId: "runtime", producerSequence: 1,
    payload: { subagentId: "child", teamRunId: "team", memberId: "worker", status: "running", observation } }]);
  assert.deepEqual(events[0], { type: "subagent", kind: "update", id: "child", status: "running", teamRunId: "team", memberId: "worker", observation });
});
