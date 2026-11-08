import assert from "node:assert/strict";
import test from "node:test";
import { compactPersonalAgentSignals } from "./signals.js";

test("large inspections retain actionable actual-use and report signals inside the normal PA allowance", () => {
  const inspection = { ok: true, inspectionId: "inspection:large", state: { issues: [
    { issueId: "issue:reconsider", revision: 8, decision: { kind: "resolved", revision: 7 }, reports: [
      { reportId: "report:new-evidence", source: { teamRunId: "team:1", taskId: "task:current", memberId: "worker" }, facts: ["x".repeat(1500)] }] },
    { issueId: "issue:open", revision: 2, decision: { kind: "unreviewed" }, reports: [{ reportId: "report:open", source: { taskId: "task:old" } }] },
  ], grants: [{ raw: "g".repeat(8000) }] }, resources: { experts: [{ raw: "e".repeat(12000) }], followUp: {
    totalPending: 40, currentTaskPending: 3, items: [{ usageReceiptId: "dispatch:actual", currentTask: true,
      owner: { kind: "expert", experienceKey: "expert:known" }, pendingVersionIds: ["version:actual"],
      boundary: { memberId: "worker", taskId: "task:current", round: 2 } }] } } };
  const text = compactPersonalAgentSignals(inspection), parsed = JSON.parse(text);

  assert.ok(text.length <= 1400);
  assert.equal(parsed.pendingUseCount, 40);
  assert.equal(parsed.currentTaskPendingUseCount, 3);
  assert.equal(parsed.issuesNeedingAttention, 2);
  assert.equal(parsed.unresolvedIssueCount, 1);
  assert.equal(parsed.uses[0].usageReceiptId, "dispatch:actual");
  assert.deepEqual(parsed.uses[0].versionIds, ["version:actual"]);
  assert.equal(parsed.issues.find((issue: { issueId: string }) => issue.issueId === "issue:reconsider").reportsAfterResolution, true);
  assert.ok(!text.includes("raw"));
  assert.ok(!text.includes("Snapshot omitted"));
});

test("overlong exact references are omitted whole while counts remain visible", () => {
  const id = "d".repeat(512), version = "v".repeat(512);
  const text = compactPersonalAgentSignals({ ok: true, state: { issues: [] }, resources: { followUp: { totalPending: 9, currentTaskPending: 2,
    items: [{ usageReceiptId: id, currentTask: true, owner: { kind: "expert" }, pendingVersionIds: [version, "w".repeat(512)], boundary: { taskId: "task" } }] } } });
  const parsed = JSON.parse(text);
  assert.ok(text.length <= 1400);
  assert.equal(parsed.pendingUseCount, 9);
  assert.deepEqual(parsed.uses, []);
  assert.ok(!text.includes(id.slice(0, 500)));
  assert.match(parsed.next, /collaboration_inspect/);
  assert.deepEqual(JSON.parse(compactPersonalAgentSignals({ ok: false, reason: "board_unavailable" })), { status: "unavailable", next: "collaboration_inspect" });
});

test("normal signals distinguish available proposals from actual pending uses without inferring adoption", () => {
  const text = compactPersonalAgentSignals({ ok: true, state: { issues: [] }, resources: {
    planSummary: { availableProposalCount: 19 }, plans: [{ versionId: "plan:available", content: { issueId: "issue:available" } }] } });
  const parsed = JSON.parse(text);
  assert.equal(parsed.availableProposalCount, 19);
  assert.equal(parsed.pendingUseCount, 0);
  assert.deepEqual(parsed.proposals, [{ issueId: "issue:available", versionId: "plan:available" }]);
  assert.ok(!text.includes("adopted"));
  assert.ok(text.length <= 1400);
  const longText = compactPersonalAgentSignals({ ok: true, state: { issues: [] }, resources: {
    planSummary: { availableProposalCount: 19 }, plans: [{ versionId: "v".repeat(512), content: { issueId: "i".repeat(512) } }] } }, 1000);
  const long = JSON.parse(longText);
  assert.ok(longText.length <= 1000);
  assert.equal(long.availableProposalCount, 19);
  assert.deepEqual(long.proposals, []);
});
