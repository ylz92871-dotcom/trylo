import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderMessage, ProviderPort } from "../../ports/provider.js";
import { createPersonalAgentProvider } from "./collaboration-parent-context.js";
import { createCollaborationObjectiveObservations } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import { createSubagentJournalSink } from "./subagent-sink.js";
import { combineEnvelopeObservers } from "./envelope-observers.js";
import { streamPreparedProvider } from "../../testing/provider-request.js";

test("the normal PA request sees pending use signals even when full collaboration state exceeds its context allowance", async () => {
  const requests: (readonly ProviderMessage[])[] = [];
  const provider: ProviderPort = { async *stream(request) { requests.push(request.messages);
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const experience = { async prepareExperience() { return { ok: true as const, text: "", versionIds: [], selectionId: "selection:none" }; },
    async recordLoad() { throw new Error("No trial experience was selected."); }, async recordDispatch() { throw new Error("No trial experience was selected."); } };
  const parent = createPersonalAgentProvider({ provider, experience, scope: "workspace:signals", turnId: "turn:signals", taskId: "task:current",
    now: () => "2026-11-04T00:00:00.000Z", warn: reason => { throw new Error(reason); }, recentFacts: () => [],
    inspect: async () => ({ ok: true, state: { issues: [], grants: [{ detail: "x".repeat(5000) }] }, resources: { followUp: {
      totalPending: 37, currentTaskPending: 1, items: [{ usageReceiptId: "dispatch:needs-feedback", currentTask: true,
        owner: { kind: "expert", experienceKey: "expert:1" }, pendingVersionIds: ["version:trial"], boundary: { taskId: "task:current", memberId: "worker", round: 1 } }] } } }) });

  for await (const event of streamPreparedProvider(parent, { attemptId: "attempt:signal", model: "development-only", messages: [], tools: [] }, new AbortController().signal)) {
    assert.equal(event.type, "finish");
  }

  assert.equal(requests.length, 1);
  const context = requests[0]!.map(message => typeof message.content === "string" ? message.content : "").join("\n");

  assert.match(context, /"pendingUseCount":37/);
  assert.match(context, /dispatch:needs-feedback/);
  assert.doesNotMatch(context, /Snapshot omitted/);
});

test("normal PA context retains a genuine member tool fact despite long immutable source coordinates", async () => {
  let context = "";
  const provider: ProviderPort = { async *stream(request) { context = request.messages.map(message => message.content).join("\n");
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const experience = { async prepareExperience() { return { ok: true as const, text: "", versionIds: [], selectionId: "selection:none" }; },
    async recordLoad() { throw new Error("No trial selected"); }, async recordDispatch() { throw new Error("No trial selected"); } };
  const parent = createPersonalAgentProvider({ provider, experience, scope: "workspace:signals", turnId: "turn:signals",
    now: () => "2026-11-04T00:00:00.000Z", warn: reason => { throw new Error(reason); },
    recentFacts: () => [{ kind: "tool_pending", sourceRef: "execution-event:member-real-tool", memberId: "worker", toolName: "read_file",
      source: { eventId: "e".repeat(512), sessionId: "s".repeat(512) } }],
    inspect: async () => ({ ok: true, state: { issues: [] }, resources: { objective: { totals: { members: 1, pendingTools: 1 } } } }) });

  for await (const event of streamPreparedProvider(parent, { attemptId: "attempt:fact", model: "development-only", messages: [], tools: [] }, new AbortController().signal)) assert.equal(event.type, "finish");

  assert.match(context, /execution-event:member-real-tool/);
  assert.match(context, /read_file/);
  assert.match(context, /"pendingTools":1/);
  assert.doesNotMatch(context, /Snapshot omitted/);
});

test("the original subagent journal fanout keeps ordinary blocker reports visible to the next normal PA request", async () => {
  const objective = createCollaborationObjectiveObservations({ scope: "workspace:progress", turnId: "turn:parent", taskId: "task:parent" });

  objective.roundPrepared({ executionId: "execution:worker", taskId: "task:child", teamRunId: "team:actual", memberId: "worker", role: "worker",
    round: 1, assignment: "Correlate the source log requests.", dependencies: [] });
  const journal = createSubagentJournalSink({ sessionId: "session:parent", turnId: "turn:parent", now: () => 0 });
  let rendered = 0, context = "";

  journal.setRenderer({ onEnvelope: combineEnvelopeObservers(() => { rendered++; }, event => objective.capture(event)) });
  journal.onEvent("subagent_update", { subagentId: "execution:worker", taskId: "task:child", teamRunId: "team:actual", memberId: "worker", round: 1,
    observation: { id: "report:unit-unknown", round: 1, kind: "report", reportState: "blocked", text: "The source does not state its timestamp unit." } }, "attempt:parent");
  await journal.flush();
  assert.equal(rendered, 1);
  const report = objective.recentFacts().find(fact => fact.kind === "member_report");
  assert.ok(report);
  const provider: ProviderPort = { async *stream(request) { context = request.messages.map(message => message.content).join("\n");
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const experience = { async prepareExperience() { return { ok: true as const, text: "", versionIds: [], selectionId: "selection:none" }; },
    async recordLoad() { throw new Error("No trial selected"); }, async recordDispatch() { throw new Error("No trial selected"); } };
  const parent = createPersonalAgentProvider({ provider, experience, scope: "workspace:progress", turnId: "turn:parent", now: () => "1970-01-01T00:00:00.000Z",
    warn: reason => { throw new Error(reason); }, recentFacts: objective.recentFacts,
    inspect: async () => ({ ok: true, state: { issues: [] }, resources: { objective: objective.inspectionView() } }) });

  for await (const event of streamPreparedProvider(parent, { attemptId: "request:next-parent", model: "development-only", messages: [], tools: [] }, new AbortController().signal)) assert.equal(event.type, "finish");

  assert.match(context, /timestamp unit/);
  assert.match(context, /member_claim/);
  assert.match(context, /"reportState":"blocked"/);
  assert.ok(context.includes(report.sourceRef), "the claim remains tied to the original canonical subagent event");
});
