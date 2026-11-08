import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "../control/index.js";
import { createPersonalAgentCollaboration, type PersonalAgentFocusedLearning, type PersonalAgentCollaborationOptions } from "./service.js";
import { hasSkillIssueSource, COLLABORATION_SKILL_FOCUS_REQUIRED } from "./focus-owner.js";

const scope = "workspace:focus-owner", now = () => "2026-11-04T00:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };

function fixture(skillLearning?: PersonalAgentFocusedLearning, focusedLearning?: PersonalAgentCollaborationOptions["focusedLearning"]) {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { load: async () => ({ ok: true, state, generation: 0 }), apply: async command => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const calls = { decide: 0, fund: 0, dispatch: 0, worker: 0 };
  const original = createCollaborationControl({ board, now, ownerId: "focus-owner", worker: { async run() {
    calls.worker++;
    return { kind: "completed", resultRefs: [] };
  } } });
  const control = { ...original,
    decide: (input: Parameters<typeof original.decide>[0]) => {
      calls.decide++;
      return original.decide(input);
    },
    fund: (input: Parameters<typeof original.fund>[0]) => {
      calls.fund++;
      return original.fund(input);
    },
    dispatch: (input: Parameters<typeof original.dispatch>[0]) => {
      calls.dispatch++;
      return original.dispatch(input);
    },
  };
  const service = createPersonalAgentCollaboration({ control, scope, turnId: "turn", allowance,
    ...(skillLearning === undefined ? {} : { skillLearning }),
    ...(focusedLearning === undefined ? {} : { focusedLearning }),
    currentResources: async () => ({ view: {}, revision: "resources" }) });

  return { original, service, calls, state: () => state };
}

async function skillIssue(h: ReturnType<typeof fixture>, mixed: boolean) {
  const reported = await h.original.report({ scope, problemKey: "procedural", report: { reportId: "skill-report",
    source: { subsystem: "skill", taskId: "source-turn", versionId: "source-session" }, facts: ["A procedural task produced evidence."], evidenceRefs: [] } });

  assert.ok(reported.ok);
  if (!mixed) return reported.issue;

  const appended = await h.original.report({ scope, problemKey: "procedural", issueId: reported.issue.issueId,
    report: { reportId: "team-followup", source: { teamRunId: "team", taskId: "task", memberId: "personal_agent" },
      facts: ["Additional team context does not transfer ownership."], evidenceRefs: [] } });

  assert.ok(appended.ok);
  return appended.issue;
}

test("PA rejects canonical skill focus before decide, fund or dispatch, including a mixed team report", async () => {
  for (const mixed of [false, true]) {
    const h = fixture(), issue = await skillIssue(h, mixed), inspected = await h.service.inspect();
    assert.ok(inspected.ok);
    const before = JSON.stringify(h.state());
    assert.deepEqual(await h.service.decide({ inspectionId: inspected.inspectionId, issueId: issue.issueId,
      expectedRevision: issue.revision, decision: "focused_learning", reason: "This must use its own skill allocation.", sourceRefs: [] }, new AbortController().signal),
    { ok: false, reason: COLLABORATION_SKILL_FOCUS_REQUIRED });
    assert.deepEqual(h.calls, { decide: 0, fund: 0, dispatch: 0, worker: 0 });
    assert.equal(JSON.stringify(h.state()), before);
  }
});

test("PA routes canonical skill focus to the mounted skill owner without spending collaboration money", async () => {
  const focused: string[] = [], controller = new AbortController();
  let resumes = 0;
  const h = fixture({ async focus(input, signal) {
    assert.equal(signal, controller.signal);
    focused.push(input.issueId);
    return { ok: true, status: "completed" };
  }, async resume() {
    resumes++;
    return { ok: true, status: "idle" };
  } });
  const issue = await skillIssue(h, true), inspected = await h.service.inspect();
  assert.ok(inspected.ok);
  const result = await h.service.decide({ inspectionId: inspected.inspectionId, issueId: issue.issueId,
    expectedRevision: issue.revision, decision: "focused_learning", reason: "Review this real procedural evidence.", sourceRefs: ["skill-report"] }, controller.signal);

  assert.deepEqual(result, { ok: true, status: "completed" });
  assert.deepEqual(focused, [issue.issueId]);
  assert.deepEqual(h.calls, { decide: 0, fund: 0, dispatch: 0, worker: 0 });
  assert.equal(h.state().centralLearningGrants?.length ?? 0, 0);
  assert.deepEqual(await h.service.resume(controller.signal), { ok: true, status: "idle" });
  assert.equal(resumes, 1);
});

test("skill ownership protection preserves PA resolved and ordinary execution decisions", async () => {
  for (const decision of ["resolved", "ordinary_execution"] as const) {
    const h = fixture(), issue = await skillIssue(h, false), inspected = await h.service.inspect();
    assert.ok(inspected.ok);
    const result = await h.service.decide({ inspectionId: inspected.inspectionId, issueId: issue.issueId, expectedRevision: issue.revision,
      decision, reason: "Existing execution handles this source.", sourceRefs: [] }, new AbortController().signal);
    assert.ok(result.ok);
    assert.deepEqual(h.calls, { decide: 1, fund: 0, dispatch: 0, worker: 0 });
  }
});

test("ownership matching uses only the canonical subsystem and leaves other subsystem sources alone", () => {
  for (const subsystem of ["method", "workflow", "tool"] as const) {
    assert.equal(hasSkillIssueSource({ reports: [{ reportId: subsystem, source: { subsystem, taskId: "task", versionId: "version" },
      facts: ["Text says skill and focused_learning, without selecting its owner."], evidenceRefs: [] }] }), false);
  }
  assert.equal(hasSkillIssueSource({ reports: [{ reportId: "team", source: { teamRunId: "skill", taskId: "task", memberId: "skill" },
    facts: ["skill"], evidenceRefs: [] }] }), false);
});

test("PA never spends collaboration funding on unmounted method, workflow or tool learning", async () => {
  for (const subsystem of ["method", "workflow", "tool"] as const) {
    const h = fixture(), report = await h.original.report({ scope, problemKey: subsystem,
      report: { reportId: `report:${subsystem}`, source: { subsystem, taskId: "task", versionId: "version" },
        facts: ["Owned learning evidence."], evidenceRefs: [] } });
    assert.ok(report.ok);
    const inspected = await h.service.inspect();
    assert.ok(inspected.ok);
    const before = JSON.stringify(h.state());

    assert.deepEqual(await h.service.decide({ inspectionId: inspected.inspectionId, issueId: report.issue.issueId,
      expectedRevision: report.issue.revision, decision: "focused_learning", reason: "Use this subsystem's own allowance.", sourceRefs: [] }, new AbortController().signal),
    { ok: false, reason: `collaboration_${subsystem}_issue_requires_${subsystem}_focus` });
    assert.equal(JSON.stringify(h.state()), before);
    assert.deepEqual(h.calls, { decide: 0, fund: 0, dispatch: 0, worker: 0 });
  }
});

test("PA exposes and selects each mounted canonical subsystem route, including prompt-domain method learning", async () => {
  for (const subsystem of ["method", "workflow", "tool", "skill"] as const) {
    const invoked: string[] = [];
    const port: PersonalAgentFocusedLearning = { async focus(input) {
      invoked.push(input.issueId);
      return { ok: true, status: "completed" };
    },
      async resume() {
        invoked.push("resume");
        return { ok: true, status: "idle" };
      } };
    const h = fixture(undefined, { [subsystem]: port });
    const report = await h.original.report({ scope, problemKey: subsystem,
      report: { reportId: `report:${subsystem}`, source: { subsystem, taskId: "task", versionId: "version" },
        facts: ["A report mentions other domains but does not select them."], evidenceRefs: [] } });
    assert.ok(report.ok);
    const inspected = await h.service.inspect();
    assert.ok(inspected.ok);
    assert.deepEqual(inspected.learningRoutes, [{ issueId: report.issue.issueId, owner: subsystem,
      focusTool: "collaboration_decide", resumeTool: "collaboration_resume", mounted: true }]);
    assert.deepEqual(await h.service.decide({ inspectionId: inspected.inspectionId, issueId: report.issue.issueId,
      expectedRevision: report.issue.revision, decision: "focused_learning", reason: "Use the actual owner.", sourceRefs: [] }, new AbortController().signal),
    { ok: true, status: "completed" });
    assert.deepEqual(invoked, [report.issue.issueId]);
    assert.equal(h.state().jobs.length, 0);
    await h.service.resume(new AbortController().signal);
    assert.deepEqual(invoked, [report.issue.issueId, "resume"]);
  }
});

test("mixed subsystem sources require separation before PA funding, while team follow-up retains its owner", async () => {
  const h = fixture(), issue = await skillIssue(h, true);
  const appended = await h.original.report({ scope, problemKey: "procedural", issueId: issue.issueId,
    report: { reportId: "workflow-source", source: { subsystem: "workflow", taskId: "task", versionId: "version" }, facts: ["Conflicting owner."], evidenceRefs: [] } });

  assert.ok(appended.ok);
  const inspected = await h.service.inspect();
  assert.ok(inspected.ok);
  const before = JSON.stringify(h.state());

  assert.equal(inspected.learningRoutes[0]?.owner, "ambiguous");
  assert.deepEqual(await h.service.decide({ inspectionId: inspected.inspectionId, issueId: issue.issueId,
    expectedRevision: appended.issue.revision, decision: "focused_learning", reason: "Conflicting ownership cannot choose money.", sourceRefs: [] }, new AbortController().signal),
  { ok: false, reason: "learning_issue_has_multiple_subsystem_owners" });
  assert.equal(JSON.stringify(h.state()), before);
});

test("PA inspects and routes only the exact legacy method scope without migrating its original grant", async () => {
  const h = fixture(), legacy = "workspace:legacy-method", foreign = "workspace:unrelated";

  for (const [sourceScope, subsystem] of [[legacy, "method"], [legacy, "tool"], [foreign, "method"]] as const) {
    const report = await h.original.report({ scope: sourceScope, problemKey: `${sourceScope}:${subsystem}`,
      report: { reportId: `${sourceScope}:${subsystem}`, source: { subsystem, taskId: "actual-source", versionId: "actual-version" },
        facts: ["The legacy source remains in its original scope."], evidenceRefs: [] } });
    assert.ok(report.ok);
  }

  const oldIssue = h.state().learningIssues!.find(issue => issue.scope === legacy && hasSkillIssueSource(issue) === false
    && issue.reports.some(report => "subsystem" in report.source && report.source.subsystem === "method"))!;
  const decided = await h.original.decide({ issueId: oldIssue.issueId, expectedRevision: oldIssue.revision,
    decision: "focused_learning", reason: "Existing approved review", sourceRefs: [] });
  assert.ok(decided.ok);
  // The shared Board owns domain prompt for method learning.
  const funded = reduce(h.state(), { type: "coordinate_learning", commandId: "legacy-method:fund", issuedAt: now(),
    action: { kind: "fund", domain: "prompt", issueId: oldIssue.issueId, expectedRevision: decided.issue.revision,
      grantId: "legacy-method-original", allowance } });
  assert.ok(funded.ok);
  // Use an actual shared writer for the legacy grant rather than a second ledger.
  const control = createCollaborationControl({ board: { load: async () => ({ ok: true, state: funded.state, generation: 0 }),
    apply: async () => { throw new Error("inspection and routed resume must not write this fixture"); } }, now, ownerId: "legacy-reader" });
  const calls: string[] = [];
  const service = createPersonalAgentCollaboration({ control, scope, legacyMethodScope: legacy, turnId: "legacy-resume", allowance,
    currentResources: async () => ({ view: {}, revision: "same-resources" }), focusedLearning: { method: {
      async focus(input) {
        calls.push(input.issueId);
        return { ok: true, status: "completed" };
      }, async resume() { return { ok: true, status: "idle" }; },
    } } });
  const before = JSON.stringify(funded.state), view = await service.inspect({ issueId: oldIssue.issueId });
  assert.ok(view.ok);
  assert.deepEqual(view.state.issues.map(issue => issue.issueId), [oldIssue.issueId]);
  assert.deepEqual(view.state.grants.map(grant => grant.grantId), ["legacy-method-original"]);
  assert.deepEqual(view.state.jobs.map(job => job.jobId), [funded.state.centralLearningGrants![0]!.jobId]);
  assert.deepEqual(await service.decide({ inspectionId: view.inspectionId, issueId: oldIssue.issueId,
    expectedRevision: view.state.issues[0]!.revision, decision: "focused_learning", reason: "Continue original review", sourceRefs: [] }, new AbortController().signal),
  { ok: true, status: "completed" });
  assert.deepEqual(calls, [oldIssue.issueId]);
  assert.equal(JSON.stringify(funded.state), before);
  const all = await service.inspect();
  assert.ok(all.ok);
  assert.equal(all.state.issues.length, 1);
});
