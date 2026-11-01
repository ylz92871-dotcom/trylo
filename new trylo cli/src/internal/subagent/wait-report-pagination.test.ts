import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderPort } from "../ports/provider.js";
import { boundToolOutput, settleToolOutcome, type ToolResultRecord } from "../loop/tool-execution.js";
import { SubagentRuntime } from "./runtime.js";
import { createSubagentControlTool } from "./control-tools.js";
import { AgentRoundObservation } from "./control-observation.js";
import { createSubagentInputChannel } from "./input-channel.js";
import { boundedWaitResponse } from "./wait-response.js";
import { emptyUsage } from "../ports/provider.js";

test("a report page cannot silently skip an answer that follows its unread reports", () => {
  const observation = new AgentRoundObservation(createSubagentInputChannel());
  for (let index = 1; index <= 3; index++) observation.publishProgress({ id: `report-${index}`, kind: "report", round: 1,
    reportState: "progress", text: `进展 ${index}` });
  observation.publish({ status: "completed", output: "完整最终答复", rounds: 1, transcript: [], envelopes: [], usage: emptyUsage() });
  const first = observation.snapshot("running", 0, undefined, 1);
  assert.equal(first["cursor"], 1);
  assert.equal(first["output"], "");
  assert.equal(first["has_more_reports"], true);
  const next = observation.snapshot("running", 1, undefined, 2);
  assert.equal(next["cursor"], 4);
  assert.equal(next["output"], "完整最终答复");
  assert.equal(next["has_more_reports"], false);
  assert.equal(observation.snapshot("running", 4)["output"], "");
});

test("an envelope too small to carry even one report refuses instead of returning a nonadvancing page", () => {
  const observation = new AgentRoundObservation(createSubagentInputChannel());
  observation.publishProgress({ id: "one", kind: "report", round: 1, reportState: "progress", text: "中".repeat(1200) });
  const read = (limit: number) => observation.snapshot("running", 0, undefined, limit);
  const emptyBudget = Buffer.byteLength(JSON.stringify({ status: { task: "running" }, timed_out: false, results: { task: read(0) } }), "utf8");
  assert.equal(boundedWaitResponse([{ target: "task", status: "running", read }], false, emptyBudget), undefined);
});

test("oversized full answers have explicit bounded previews inside complete JSON", () => {
  const answer = boundedWaitResponse([{ target: "task", status: "completed", read: () => ({ reports: [], output: "中😀".repeat(50000), cursor: 1 }) }], false, 4096);
  assert.ok(answer);
  assert.ok(Buffer.byteLength(JSON.stringify(answer), "utf8") <= 4096);
  const row = (answer["results"] as JsonObject)["task"] as JsonObject;
  assert.equal(row["output_truncated"], true);
  assert.equal(String(row["output"]).includes("\uFFFD"), false);
});

test("multiple full mailboxes survive the real model-output boundary and can be read without gaps", async t => {
  const rounds = new Map<string, number>();
  const provider: ProviderPort = { async *stream(request, signal) {
    const task = request.messages.find(message => message.role === "user")?.content ?? "";
    const round = (rounds.get(task) ?? 0) + 1; rounds.set(task, round);
    if (round === 1) {
      for (let index = 1; index <= 16; index++) yield { type: "tool_call", name: "report_progress", toolCallId: `report-${index}`,
        arguments: { state: "progress", message: `${index}:` + "中".repeat(1195) } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  } };
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });
  t.after(() => runtime.cancelAll());
  const control = createSubagentControlTool({ runtime, provider, permission: {
    request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); },
  } });
  const signal = new AbortController().signal;
  const targets: string[] = [];
  for (const message of ["member-a", "member-b"]) {
    const result = await control.execute({ name: "spawn_agent", toolCallId: message, arguments: { message } }, signal);
    assert.equal(result.outcome, "result");
    if (result.outcome === "result") targets.push(String(result.value["task_id"]));
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  const after: Record<string, number> = {}; const seen = new Map(targets.map(target => [target, new Set<string>()]));
  for (let page = 0; page < 10; page++) {
    const call = { name: "wait_agent", toolCallId: `read-${page}`, arguments: { targets, after, timeout_ms: 0, wake_on_report: true } };
    const outcome = await control.execute(call, signal);
    assert.equal(outcome.outcome, "result");
    if (outcome.outcome !== "result") return;
    const bounded = boundToolOutput(outcome.output, outcome.truncated);
    assert.equal(bounded.truncated, false, "the execution loop must not slice report JSON");
    let recorded: ToolResultRecord | undefined;
    await settleToolOutcome({ emit: () => {}, dispatch: async () => {}, nextEventId: () => "event",
      recordResult: result => { recorded = result; } }, call, outcome);
    assert.ok(recorded);
    const answer = JSON.parse(recorded.output) as JsonObject;
    let more = false;
    for (const target of targets) {
      const row = (answer["results"] as JsonObject)[target] as JsonObject;
      assert.equal(row["phase"], "working");
      for (const report of row["reports"] as JsonObject[]) {
        assert.equal(seen.get(target)!.has(String(report["id"])), false, "after must not replay reports");
        assert.equal(String(report["message"]).length >= 1197, true, "a page preserves each complete report message");
        seen.get(target)!.add(String(report["id"]));
      }
      after[target] = Number(row["cursor"]);
      more ||= row["has_more_reports"] === true;
    }
    if (!more) break;
  }
  assert.deepEqual(targets.map(target => seen.get(target)!.size), [16, 16]);
});
