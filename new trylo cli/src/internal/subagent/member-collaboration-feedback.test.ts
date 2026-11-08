import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "../ports/provider.js";
import type { SubagentObservation } from "../protocol/subagent-observation.js";
import { isSubagentObservation } from "../protocol/subagent-observation.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import { withMemberReporting } from "./user-progress.js";
import { withCollaborationReporting } from "./collaboration-reporting.js";
import { AgentRoundObservation } from "./control-observation.js";
import { createSubagentInputChannel } from "./input-channel.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";

const collaboration = { summary: "The assigned export is blocked", facts: ["The configured tool list has no exporter"],
  suspectedCauses: ["This member configuration may be incomplete"], evidenceRefs: [], issueRef: "issue:export" };
const baseTools = { snapshot: () => [], execute: async () => ({ outcome: "cancelled" as const }), cancel: async () => {} };
const permission = { request: async () => { throw new Error("Reporting grants no approval"); },
  awaitDecision: async () => { throw new Error("Reporting must not ask permission"); } };

test("normal progress carries facts and suspected causes without requiring proved references", async () => {
  const events: SubagentObservation[] = [];
  const tools = withMemberReporting(baseTools, event => events.push(event), () => 2);
  const result = await tools.execute({ toolCallId: "report-a", name: "report_progress",
    arguments: { state: "blocked", message: "Export is waiting for the parent.", collaboration } }, new AbortController().signal);

  assert.equal(result.outcome, "result");
  assert.deepEqual(events[0], { id: "report-a", round: 2, kind: "report", reportState: "blocked",
    text: "Export is waiting for the parent.", collaboration: { schemaVersion: 1, id: "report-a", ...collaboration } });
  assert.ok(isSubagentObservation(events[0]));
  const mailbox = new AgentRoundObservation(createSubagentInputChannel());
  mailbox.publishProgress(events[0]!);
  assert.deepEqual(mailbox.snapshot("running").reports, [{ id: "report-a", round: 2, state: "blocked",
    message: "Export is waiting for the parent.", cursor: 1, collaboration: { schemaVersion: 1, id: "report-a", ...collaboration } }]);
  assert.equal(mailbox.isReady(), false, "an authored blocker does not finish its round");
});

test("malformed structured feedback is rejected without publishing a partial observation", async () => {
  const events: SubagentObservation[] = [];
  const tools = withMemberReporting(baseTools, event => events.push(event), () => 1);

  for (const value of [{ ...collaboration, facts: [] }, { ...collaboration, suspectedCauses: [42] },
    { ...collaboration, evidenceRefs: ["x".repeat(513)] }]) {
    const result = await tools.execute({ toolCallId: "invalid", name: "report_progress",
      arguments: { state: "progress", message: "Progress", collaboration: value } }, new AbortController().signal);
    assert.equal(result.outcome, "error");
  }

  assert.equal(events.length, 0);
});

test("legacy collaboration reporting is a structured normal-progress compatibility path", async () => {
  const events: SubagentObservation[] = [], reports: unknown[] = [];
  const tools = withCollaborationReporting(baseTools, event => events.push(event), () => 1, async report => { reports.push(report); });
  const result = await tools.execute({ toolCallId: "legacy", name: "report_collaboration_observation", arguments: {
    dimension: "handoff", summary: "Need the source artifact", evidence_refs: [], operation: "request_context",
  } }, new AbortController().signal);

  assert.equal(result.outcome, "result");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.reportState, "blocked");
  assert.ok("collaboration" in events[0]!, "legacy callers must reach the same structured mailbox");
  assert.equal(reports.length, 1);
});

test("normal reporting reaches the optional parent observer without another reflection and survives observer failure", async () => {
  let requests = 0;
  const events: SubagentObservation[] = [], reports: unknown[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests += 1;
    if (requests === 1) {
      assert.ok(request.messages.some(message => message.content.includes("suspectedCauses")));
      yield { type: "tool_call", toolCallId: "normal", name: "report_progress",
        arguments: { state: "progress", message: "The parent needs the current facts.", collaboration } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "Scoped work continues" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const worker = createInteractiveChildWorker({ provider, permission, message: "Inspect exports",
    onCollaborationReport: async report => {
      reports.push(report);
      throw new Error("Parent observer unavailable");
    } });
  const result = await worker({ subagentId: "worker", name: "Worker", lineage: { parentAgentId: "parent", rootAttemptId: "root" },
    signal: new AbortController().signal, tools: baseTools, reportProgress: () => {}, recordUsage: () => {}, reportObservation: event => events.push(event) });

  assert.equal(reports.length, 1);
  assert.equal(requests, 2, "only the authored tool call and ordinary continuation run");
  assert.equal(result.output, "Scoped work continues");
  assert.equal(events.filter(event => event.kind === "report").length, 1);
  assert.ok(result.envelopes.some(event => event.kind === "tool_result" && event.payload.toolCallId === "normal" && event.payload.status === "succeeded"));
});

test("execution-owned parent hooks receive a worker report when no learning port is mounted", async t => {
  let requests = 0;
  const received: unknown[] = [];
  const provider: ProviderPort = { async *stream() {
    if (++requests === 1) {
      yield { type: "tool_call", toolCallId: "worker-report", name: "report_progress", arguments: { state: "progress", message: "Current facts", collaboration } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else { yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; }
  } };
  const runtime = new SubagentRuntime({ tools: baseTools });
  t.after(() => runtime.cancelAll());
  const options = { runtime, provider, permission,
    onMemberCollaborationReport: async (context: unknown, report: unknown) => { received.push({ context, report }); } };
  const tools = createSubagentControlTool(options);
  const spawned = await tools.execute({ name: "spawn_agent", toolCallId: "spawn", arguments: { message: "Inspect" } }, new AbortController().signal);

  assert.equal(spawned.outcome, "result");
  if (spawned.outcome !== "result") return;

  const id = String(spawned.value.agent_id);

  await tools.execute({ name: "wait_agent", toolCallId: "wait", arguments: { targets: [id], timeout_ms: 1000, wake_on_report: true } }, new AbortController().signal);
  assert.equal(received.length, 1);
  const record = received[0] as { context: { executionId: string; taskId: string; round: number }; report: { issueRef: string } };

  assert.equal(record.context.executionId, id);
  assert.equal(record.context.taskId, String(spawned.value.task_id));
  assert.equal(record.context.round, 1);
  assert.equal(record.report.issueRef, "issue:export");
});
