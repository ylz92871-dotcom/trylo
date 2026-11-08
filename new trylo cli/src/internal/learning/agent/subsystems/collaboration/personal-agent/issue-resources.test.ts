import assert from "node:assert/strict";
import test from "node:test";
import { projectIssueResources } from "./issue-resources.js";
import { createPersonalAgentCollaboration, type PersonalAgentInspectionInput } from "./service.js";
import { createPersonalAgentTools } from "../runtime/personal-agent-tools.js";
import { createCollaborationControl } from "../control/index.js";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import type { BoardStore } from "../../../../control/store-port.js";

const NOW = "2026-11-04T00:00:00.000Z", scope = "workspace:issue-inspection";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 1200 };
const plan = (issueId: string) => ({ schema: "collaboration-plan/v1", issueId, focusRevision: 1, familyId: "artifact", title: "Exact artifact handoff",
  summary: "Preserve the original consumer contract.", sourceRefs: ["source:actual"],
  adjustments: [{ memberId: "producer", kind: "handoff", instruction: "Supply the current contract and unfinished work." }], experienceVersionIds: [], needs: [] });

test("issue resource projection preserves actual objective/follow-up and relevant plans while omitting unrelated configurations and authorization", () => {
  const issueId = "issue:chosen", objective = { facts: [{ eventId: "event:actual", outcome: "waiting" }] },
    followUp = { totalPending: 1, items: [{ usageReceiptId: "dispatch:actual", versionIds: ["version:actual"] }], page: { omitted: 0 } };
  const raw = { objective, followUp, team: { runId: "team:actual", profileId: "profile:actual", surface: "code", configurationBasis: "frozen_team_profile", members: [
    { memberId: "producer", baseRole: "worker", role: { name: "worker", description: "Produces artifacts", prompt: "PRIVATE_ROLE_PROMPT", allowedTools: ["read_file"] },
      expert: { expertId: "expert:initial", version: 1 }, configurationRef: "configuration:initial",
      lastPreparedBoundary: { executionId: "execution:actual", taskId: "task:actual", round: 2,
        configurationRef: "configuration:actual", identity: { expertId: "expert:actual", version: 3, experienceKey: "owner:actual" },
        responsibilities: ["Produces artifacts", "Checks inventory"], privateInstructions: "PRIVATE_PREPARED_PROMPT" } }] },
    plans: [{ versionId: "plan:chosen", content: plan(issueId) }, { versionId: "plan:other", content: plan("issue:other") }],
    expertRequests: [
      { requestId: "request:chosen", expertId: "expert:actual", state: "authorized", revision: 2, association: { issueId, jobId: "job:actual" },
        configurationRef: "configuration:chosen", configuration: { prompt: "PRIVATE_CONFIGURATION" }, userEdits: { x: "PRIVATE_EDITS" }, creationAuthorization: "PRIVATE_AUTH" },
      { requestId: "request:other", expertId: "expert:other", state: "saved", revision: 1, association: { issueId: "issue:other" } }],
    owners: Array.from({ length: 14 }, (_, index) => ({ ref: `member:${index}`, input: {
      owner: { kind: "expert", experienceKey: `experience:${index}` }, maxChars: 600 } })),
    experts: [{ configuration: { prompt: "PRIVATE_LIBRARY_PROMPT" } }],
    tools: { ok: true, value: { total: 77, items: [{ description: "PRIVATE_TOOL_DETAILS" }] } }, receipts: [{ receiptId: "old:receipt" }] };
  const before = JSON.stringify(raw), result = projectIssueResources(raw, issueId);

  assert.ok("plans" in result);
  assert.deepEqual(result.objective, objective);
  assert.deepEqual(result.followUp, followUp);
  assert.deepEqual(result.plans.map(item => item.versionId), ["plan:chosen"]);
  assert.equal(result.expertRequests.length, 1);
  const request = result.expertRequests[0];

  assert.ok(request && "requestId" in request && "configurationRef" in request);
  assert.equal(request.requestId, "request:chosen");
  assert.equal(request.configurationRef, "configuration:chosen");
  assert.equal(result.owners.length, 12);
  assert.equal(result.omitted.owners.omitted, 2);
  assert.ok("configurationBasis" in result.team && "members" in result.team);
  assert.equal(result.team.configurationBasis, "frozen_team_profile");
  assert.equal(result.team.members[0]?.expert?.version, 1);
  assert.equal(result.team.members[0]?.lastPreparedBoundary?.identity?.version, 3);
  assert.equal(result.team.members[0]?.role.frozenAllowedToolCount, 1);
  assert.equal(result.omitted.plans.unrelatedProvided, 1);
  assert.equal(result.omitted.expertRequests.unrelatedProvided, 1);
  assert.equal(result.experts.details, "omitted");
  assert.equal(result.tools.catalogueTotal, 77);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.equal(JSON.stringify(raw), before);
  assert.match(result.omitted.note, /not empty libraries/);
});

test("invalid resource views are explicitly unavailable rather than projected as empty catalogues", () => {
  assert.deepEqual(projectIssueResources(null, "issue:chosen"), { schema: "collaboration-issue-resources/v1", issueId: "issue:chosen", unavailable: "resource_view_invalid" });
  const result = projectIssueResources({}, "issue:chosen");
  assert.ok("experts" in result);
  assert.equal(result.experts.providedCount, "unknown");
  assert.equal(result.tools.catalogueTotal, "unknown");
});

async function harness() {
  let state = emptyBoardState(), resourceRevision = "resources:1";
  const reads: (PersonalAgentInspectionInput | undefined)[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "issue-inspection-owner" });
  const reported = [];

  for (const key of ["chosen", "other"]) {
    const issue = await control.report({ scope, problemKey: key, report: { reportId: `report:${key}`,
      source: { teamRunId: "team:actual", taskId: `task:${key}`, memberId: "producer" }, facts: ["A consumer contract is missing."], evidenceRefs: [] } });

    assert.ok(issue.ok);
    const focus = await control.decide({ issueId: issue.issue.issueId, expectedRevision: issue.issue.revision, decision: "focused_learning",
      reason: "PA selected this concrete issue.", sourceRefs: [`report:${key}`] });
    assert.ok(focus.ok);
    const funded = await control.fund({ issueId: focus.issue.issueId, expectedRevision: focus.issue.revision, grantId: `grant:${key}`, allowance });
    assert.ok(funded.ok);
    reported.push(funded.issue);
  }

  const pa = createPersonalAgentCollaboration({ control, scope, turnId: "turn:inspection", allowance,
    currentResources: async input => {
      reads.push(input);
      return { view: { selectedIssue: input?.issueId, cursor: input?.followUpAfterReceiptId }, revision: resourceRevision };
    } });

  return { control, pa, chosen: reported[0]!, other: reported[1]!, reads, state: () => state,
    changeResource: () => { resourceRevision = "resources:2"; } };
}

test("focused inspection selects one issue and current pointers but retains the same complete freshness token and decision CAS", async () => {
  const h = await harness(), full = await h.pa.inspect(), before = JSON.stringify(h.state());
  assert.ok(full.ok);
  const selected = await h.pa.inspect({ issueId: h.chosen.issueId, followUpAfterReceiptId: "cursor:actual" });
  assert.ok(selected.ok);
  assert.equal(selected.inspectionId, full.inspectionId);
  assert.deepEqual(selected.state.issues.map(item => item.issueId), [h.chosen.issueId]);
  assert.deepEqual(selected.state.jobs.map(item => item.jobId), [h.chosen.jobId]);
  assert.deepEqual(selected.state.grants.map(item => item.grantId), [h.chosen.grantId]);
  assert.ok("historySummary" in selected);
  assert.equal(selected.historySummary.hiddenIssues, 1);
  assert.deepEqual(h.reads.at(-1), { issueId: h.chosen.issueId, followUpAfterReceiptId: "cursor:actual" });
  assert.equal(JSON.stringify(h.state()), before);
  const decided = await h.pa.decide({ inspectionId: selected.inspectionId, issueId: h.chosen.issueId, expectedRevision: h.chosen.revision,
    decision: "ordinary_execution", reason: "The current consumer contract resolves this scheduling issue.", sourceRefs: [] }, new AbortController().signal);

  assert.ok(decided.ok);
  assert.equal(h.state().centralLearningGrants?.length, 2);
});

test("a hidden other issue or actual resource change still invalidates a focused token and unknown selection stays explicit", async () => {
  for (const change of ["hidden_issue", "resource"] as const) {
    const h = await harness(), selected = await h.pa.inspect({ issueId: h.chosen.issueId });
    assert.ok(selected.ok);

    if (change === "resource") h.changeResource();
    else assert.ok((await h.control.report({ scope, issueId: h.other.issueId, problemKey: "other", report: { reportId: "report:other:new",
      source: { teamRunId: "team:actual", taskId: "task:other:new", memberId: "producer" }, facts: ["A new actual constraint arrived."], evidenceRefs: [] } })).ok);

    assert.deepEqual(await h.pa.decide({ inspectionId: selected.inspectionId, issueId: h.chosen.issueId, expectedRevision: h.chosen.revision,
      decision: "resolved", reason: "This token predates current facts.", sourceRefs: [] }, new AbortController().signal),
    { ok: false, reason: "collaboration_state_changed_inspect_again" });
  }

  const h = await harness(), reads = h.reads.length;

  assert.deepEqual(await h.pa.inspect({ issueId: "issue:absent" }), { ok: false, reason: "learning_issue_not_found" });
  assert.equal(h.reads.length, reads);
});

test("the original inspect tool passes bounded issue/cursor references and rejects malformed selection before any state write", async () => {
  const h = await harness(), unexpected = (): never => { throw new Error("Read projection cannot call libraries, capabilities or feedback"); };
  const tools = createPersonalAgentTools({ service: h.pa, scope, turnId: "turn:inspection", library: unexpected, capability: unexpected, feedback: unexpected });
  const accepted = await tools.execute({ name: "collaboration_inspect", toolCallId: "inspect:chosen",
    arguments: { issueId: h.chosen.issueId, followUpAfterReceiptId: "cursor:actual" } }, new AbortController().signal);

  assert.equal(accepted.outcome, "result");
  assert.deepEqual(h.reads.at(-1), { issueId: h.chosen.issueId, followUpAfterReceiptId: "cursor:actual" });
  const before = JSON.stringify(h.state()), reads = h.reads.length;

  for (const issueId of ["", " ", "bad\0id", "i".repeat(513)]) {
    assert.equal((await tools.execute({ name: "collaboration_inspect", toolCallId: "inspect:bad", arguments: { issueId } }, new AbortController().signal)).outcome, "error");
  }

  assert.equal(h.reads.length, reads);
  assert.equal(JSON.stringify(h.state()), before);
});
