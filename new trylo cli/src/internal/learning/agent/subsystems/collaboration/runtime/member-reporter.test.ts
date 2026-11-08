import assert from "node:assert/strict";
import test from "node:test";
import type { MemberCollaborationReport, MemberCollaborationReportContext } from "../../../../../protocol/member-collaboration-report.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "../control/index.js";
import { compactPersonalAgentSignals } from "../personal-agent/signals.js";
import { createCollaborationMemberReporter } from "./member-reporter.js";

const scope = "workspace:member-report-identity", NOW = "2026-11-04T00:00:00.000Z";
const context = (memberId: string): MemberCollaborationReportContext => ({ executionId: `execution:${memberId}`,
  taskId: `task:${memberId}`, round: 1, role: "worker", memberId, teamRunId: "team:actual" });

async function fixture(holdFirstTwoReads = false) {
  let state = emptyBoardState();
  const warnings: string[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "member-report-contract" });
  const seeded = await control.report({ scope, problemKey: "shared-handoff", report: { reportId: "report:seed",
    source: { teamRunId: "team:actual", taskId: "task:seed", memberId: "personal_agent" }, facts: ["A source handoff needs attention."], evidenceRefs: [] } });
  assert.ok(seeded.ok);
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reporter = createCollaborationMemberReporter({ scope, turnId: "turn:host", enabled: () => true, warn: reason => warnings.push(reason),
    control: { report: control.report, async read(inputScope) {
      const snapshot = await control.read(inputScope);
      if (holdFirstTwoReads && ++reads <= 2) {
        if (reads === 2) release();
        await gate;
      }
      return snapshot;
    } } });
  const report = (fact: string): MemberCollaborationReport => ({ schemaVersion: 1, id: "provider-local-call-id", summary: "A concrete member observation.",
    facts: [fact], suspectedCauses: [], evidenceRefs: [], issueRef: seeded.issue.issueId });

  return { reporter, report, control, issueId: seeded.issue.issueId, warnings, state: () => state };
}

test("concurrent members sharing a provider call ID append both immutable facts; exact replay is idempotent and changed canonical payload conflicts", async () => {
  const h = await fixture(true), a = context("worker-a"), b = context("worker-b"), reportA = h.report("A is missing the source artifact."), reportB = h.report("B observed a consumer dependency.");

  await Promise.all([h.reporter(a, reportA), h.reporter(b, reportB)]);
  const issue = h.state().learningIssues!.find(value => value.issueId === h.issueId)!;

  assert.equal(issue.reports.length, 3);
  assert.deepEqual(new Set(issue.reports.slice(1).map(value => JSON.stringify(value.source))), new Set([
    { teamRunId: "team:actual", taskId: "task:worker-a", memberId: "worker-a" }, { teamRunId: "team:actual", taskId: "task:worker-b", memberId: "worker-b" } ].map(value => JSON.stringify(value))));
  assert.equal(new Set(issue.reports.map(value => value.reportId)).size, 3);
  assert.deepEqual(h.warnings, []);
  assert.ok(issue.reports.slice(1).every(value => value.reportId.startsWith("collaboration-member-report:")));
  const beforeReplay = JSON.stringify(h.state());
  await h.reporter(a, reportA);
  assert.equal(JSON.stringify(h.state()), beforeReplay);
  await h.reporter(a, { ...reportA, facts: ["The same original report identity now asserts a different fact."] });
  assert.equal(JSON.stringify(h.state()), beforeReplay);
  assert.deepEqual(h.warnings, ["command_payload_conflict"]);
  const firstRequest = { ...a, requestId: "actual-shared-attempt", requestSequence: 1 }, secondRequest = { ...firstRequest, requestSequence: 2 };

  await Promise.all([h.reporter(firstRequest, reportA), h.reporter(secondRequest, reportA)]);
  const requestReports = h.state().learningIssues!.find(value => value.issueId === h.issueId)!.reports;

  assert.equal(requestReports.length, 5);
  assert.equal(new Set(requestReports.slice(-2).map(value => value.reportId)).size, 2,
    "same sender, attempt and local call ID in distinct actual request ordinals remain separate facts");
  const beforeRequestReplay = JSON.stringify(h.state());
  await h.reporter(firstRequest, reportA);
  assert.equal(JSON.stringify(h.state()), beforeRequestReplay);
  assert.deepEqual(h.warnings, ["command_payload_conflict"]);
  const { issueRef: _issueRef, ...unbound } = h.report("An independent new issue without a supplied relationship.");

  await Promise.all([h.reporter(context("worker-c"), unbound), h.reporter(context("worker-d"), unbound)]);
  assert.equal(h.state().learningIssues!.length, 3, "a reused local call ID cannot silently merge unrelated unbound reports");
});

test("new facts appended to a resolved issue preserve its decision and budgets while normal PA signals request renewed attention", async () => {
  const h = await fixture(), issue = h.state().learningIssues!.find(value => value.issueId === h.issueId)!;
  const resolved = await h.control.decide({ issueId: issue.issueId, expectedRevision: issue.revision,
    decision: "resolved", reason: "The original source handoff was supplied.", sourceRefs: ["report:seed"] });
  assert.ok(resolved.ok);
  await h.reporter(context("worker-a"), h.report("The downstream consumer now reports a different wire contract."));
  const latest = h.state().learningIssues!.find(value => value.issueId === h.issueId)!;

  assert.deepEqual(latest.decision, resolved.issue.decision);
  assert.equal(latest.revision, resolved.issue.revision + 1);
  assert.equal(latest.reports.length, 2);
  assert.equal(h.state().jobs.length, 0);
  assert.equal(h.state().centralLearningGrants?.length ?? 0, 0);
  const signals = JSON.parse(compactPersonalAgentSignals({ ok: true, state: { issues: [latest] }, resources: {} }));

  assert.equal(signals.unresolvedIssueCount, 0);
  assert.equal(signals.issuesNeedingAttention, 1);
  assert.equal(signals.issues[0].reportsAfterResolution, true);
  assert.deepEqual(h.warnings, []);
});
