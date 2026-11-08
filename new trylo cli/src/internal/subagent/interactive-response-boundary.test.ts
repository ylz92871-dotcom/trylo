import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { SubagentContext } from "./types.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";

const context = (): SubagentContext => ({ subagentId: "member:response", name: "response-boundary",
  lineage: { parentAgentId: "parent", rootAttemptId: "attempt:parent" }, signal: new AbortController().signal,
  tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
  reportProgress: () => {}, recordUsage: () => {} });
const permission = { request: async () => { throw new Error("No business tool or approval is expected."); },
  awaitDecision: async () => { throw new Error("No business tool or approval is expected."); } };

test("adapter-local child stream startup followed by a before-header failure never records request or round exposure", async () => {
  let requests = 0, requestDispatches = 0, roundDispatches = 0;
  const provider: ProviderPort = { async *stream() { requests += 1;
    yield { type: "stream_start", providerId: "development-only", model: "development-only", warnings: [] };
    yield { type: "error", class: "network", retryable: false, phase: "before_headers", message: "A local pre-header failure." };
  } };
  const worker = createInteractiveChildWorker({ provider, permission, message: "Complete the assigned member task.",
    onRequestDispatched: async () => { requestDispatches += 1; }, onRoundDispatched: async () => { roundDispatches += 1; } });

  await assert.rejects(worker(context()));
  assert.equal(requests, 1);
  assert.equal(requestDispatches, 0);
  assert.equal(roundDispatches, 0);
});

test("a real child response records one round exposure and the exact guidance actually sent", async () => {
  let requestDispatches = 0;
  const roundDispatches: { round: number; guidance: string | undefined }[] = [];
  const provider: ProviderPort = { async *stream() {
    yield { type: "stream_start", providerId: "development-only", model: "development-only", warnings: [] };
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "Member answer." };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const worker = createInteractiveChildWorker({ provider, permission, message: "Complete the assigned member task.",
    prepareRound: async () => "Exact current trial guidance.", onRequestDispatched: async () => { requestDispatches += 1; },
    onRoundDispatched: async (round, _requestId, guidance) => { roundDispatches.push({ round, guidance }); } });
  const result = await worker(context());
  assert.equal(result.status, "completed");
  assert.equal(requestDispatches, 1);
  assert.deepEqual(roundDispatches, [{ round: 1, guidance: "Exact current trial guidance." }]);
});

test("normal collaboration reports carry actual attempt IDs and distinct host request ordinals within one work round", async t => {
  const requests: ProviderRequest[] = [], reports: { id: string; requestId: string | undefined; sequence: number | undefined }[] = [];
  const reportRounds: number[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    const index = requests.length;
    if (index <= 2) {
      // IDs remain unique for the original Loop/mailbox; this contract does not alter their execution deduplication.
      yield { type: "tool_call", toolCallId: `report-call:${index}`, name: "report_progress", arguments: {
        state: "progress", message: `Observed milestone ${index}.`, collaboration: {
          summary: `Coordination observation ${index}.`, facts: [`Actual milestone ${index} needs coordination.`], suspectedCauses: [], evidenceRefs: [] } } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      return;
    }

    yield { type: "text_start", blockId: "done" };
    yield { type: "text_delta", blockId: "done", text: "Member finished." };
    yield { type: "text_end", blockId: "done" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const worker = createInteractiveChildWorker({ provider, permission, message: "Report the two actual coordination milestones, then finish.",
    onCollaborationReport: async (report, requestId, sequence) => { reports.push({ id: report.id, requestId, sequence }); },
    onProgressReport: report => { reportRounds.push(report.round); } });
  const result = await worker(context());
  assert.equal(result.status, "completed");
  assert.equal(result.rounds, 1);
  assert.equal(requests.length, 3);
  t.diagnostic(`Observed ${requests.length} provider requests across ${new Set(requests.map(request => request.attemptId)).size} execution attempt IDs.`);
  assert.deepEqual(reports, [{ id: "report-call:1", requestId: requests[0]!.attemptId, sequence: 1 },
    { id: "report-call:2", requestId: requests[1]!.attemptId, sequence: 2 }],
    "each collaboration report must identify the actual attempt and host stream ordinal that produced it");
  assert.deepEqual(reportRounds, [1, 1]);
});
