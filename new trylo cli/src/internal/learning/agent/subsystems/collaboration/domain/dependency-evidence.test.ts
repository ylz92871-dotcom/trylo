import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState, type BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "../control/index.js";
import { createCollaborationExperienceStore } from "../experience/store.js";
import { collaborationExperienceSourcesValid } from "../experience/provenance.js";
import { isCollaborationExperienceContent } from "../experience/parse.js";
import { collaborationPlanPublicationValid, collaborationPlanSourcesValid } from "../orchestration/parse.js";
import type { CollaborationPlan } from "../orchestration/contracts.js";
import { publishCollaborationArtifact } from "../artifacts/publish.js";
import { collaborationDependencySourceRefs } from "./dependency-evidence.js";

const scope = "workspace:dependency-evidence", NOW = "2026-11-04T00:00:00.000Z";
const dependencyId = "dependency:canonical-result", resultRef = "fixture:library-result", metadataRef = "metadata:creation-authorization-reference";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };

async function fixture() {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  // Pure Board contract fixture: no provider, actual expert/tool construction, Permission object or approval action is created.
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "dependency-contract",
    worker: { async run() { return { kind: "waiting_dependency", dependencies: [{ dependencyId, owner: "expert",
      correlationRef: "fixture:plan#need:0", state: { kind: "waiting", reason: "Fixture awaits a library result observation." } }] }; } } });
  const reported = await control.report({ scope, problemKey: "capability-handoff", report: { reportId: "report:dependency",
    source: { teamRunId: "team:fixture", taskId: "task:fixture", memberId: "worker" }, facts: ["A capability result needs a source association."], evidenceRefs: [] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "PA selected a reusable coordination issue.", sourceRefs: ["report:dependency"] });
  assert.ok(focused.ok);
  assert.ok(focused.issue.decision.kind === "focused_learning");
  const focusRevision = focused.issue.decision.revision;
  const funded = await control.fund({ issueId: focused.issue.issueId, expectedRevision: focused.issue.revision, grantId: "grant:dependency", allowance });
  assert.ok(funded.ok);
  assert.ok((await control.dispatch({ scope })).ok);
  const ready = async () => {
    const dependency = state.learningDependencies!.find(value => value.dependencyId === dependencyId)!;
    assert.ok((await control.updateDependency({ dependencyId, expectedRevision: dependency.revision,
      state: { kind: "ready", resultRef, resultVersion: "1", evidenceRefs: [metadataRef] } })).ok);
  };

  return { board, control, ready, state: () => state, issueId: focused.issue.issueId, focusRevision, grantId: funded.grant.grantId, jobId: funded.jobId };
}

test("only linked canonical ready results become sources, while consent metadata and other scopes or focuses remain excluded", async () => {
  const h = await fixture(), input = { scope, issueId: h.issueId, focusRevision: h.focusRevision, grantId: h.grantId };

  assert.deepEqual(collaborationDependencySourceRefs(h.state(), input), []);
  await h.ready();
  const before = JSON.stringify(h.state()), refs = collaborationDependencySourceRefs(h.state(), input);

  assert.deepEqual(refs, [dependencyId, resultRef]);
  assert.ok(!refs.includes(metadataRef));
  assert.ok(!refs.includes(h.grantId));
  assert.equal(JSON.stringify(h.state()), before);
  assert.deepEqual(collaborationDependencySourceRefs(h.state(), { ...input, scope: "workspace:foreign" }), []);
  assert.deepEqual(collaborationDependencySourceRefs(h.state(), { ...input, focusRevision: h.focusRevision + 1 }), []);
  assert.deepEqual(collaborationDependencySourceRefs(h.state(), { ...input, grantId: "grant:foreign" }), []);
  const dependency = h.state().learningDependencies![0]!, grant = h.state().centralLearningGrants![0]!, job = h.state().jobs[0]!;
  const malformed: BoardState[] = [
    { ...h.state(), learningDependencies: [{ ...dependency, grantId: "grant:orphan" }] },
    { ...h.state(), learningDependencies: [{ ...dependency, issueId: "issue:orphan" }] },
    { ...h.state(), learningDependencies: [{ ...dependency, requestId: "fixture:request", state: { kind: "authorized", authorizationRef: metadataRef } }] },
    { ...h.state(), centralLearningGrants: [{ ...grant, scope: "workspace:foreign" }] },
    { ...h.state(), centralLearningGrants: [{ ...grant, focusRevision: h.state().learningIssues![0]!.revision + 1 }] },
    { ...h.state(), centralLearningGrants: [{ ...grant, domain: "prompt" }] },
    { ...h.state(), jobs: [{ ...job, scope: "workspace:foreign" }] },
    { ...h.state(), jobs: [{ ...job, domain: "prompt" }] },
    { ...h.state(), jobs: [{ ...job, coordination: { issueId: h.issueId, grantId: "grant:orphan" } }] },
  ];

  for (const state of malformed) assert.deepEqual(collaborationDependencySourceRefs(state, input), []);
});

test("experience and plan share ready dependency qualification and retain historical sources after resolution and a later focus", async () => {
  const h = await fixture();
  await h.ready();
  const owner = { kind: "legacy_member", workspace: scope, profileId: "profile:fixture", memberId: "worker" } as const;
  const store = createCollaborationExperienceStore({ board: h.board, scope, now: () => NOW });
  const published = await store.publishExperience({ issueId: h.issueId, owner, familyId: "library-handoff", situation: "A library result is ready",
    responsibilities: ["Share a concrete capability reference"], practice: "Carry the ready library result reference into the next handoff.", sourceRefs: [dependencyId, resultRef] });
  assert.ok(published.ok);
  const asset = h.state().assets.find(value => value.versionId === published.versionId)!;
  assert.ok(isCollaborationExperienceContent(asset.content));
  const plan: CollaborationPlan = { schema: "collaboration-plan/v1", issueId: h.issueId, focusRevision: h.focusRevision,
    familyId: "library-handoff", title: "Use the ready reference at the handoff", summary: "A ready capability result is a source, not task-quality proof.",
    sourceRefs: [dependencyId, resultRef], adjustments: [{ memberId: "worker", kind: "handoff", instruction: "Preserve the actual ready result reference." }],
    experienceVersionIds: [published.versionId], needs: [] };

  assert.ok(collaborationPlanPublicationValid(h.state(), scope, plan));
  assert.ok((await publishCollaborationArtifact({ board: h.board, scope, now: () => NOW }, { issueId: h.issueId, familyId: plan.familyId,
    title: plan.title, hypothesis: plan.summary, sourceRefs: plan.sourceRefs, content: plan, schemaVersion: 3, kind: "plan" })).ok);
  const before = h.state().learningIssues!.find(value => value.issueId === h.issueId)!;
  const resolved = await h.control.decide({ issueId: h.issueId, expectedRevision: before.revision,
    decision: "resolved", reason: "The current issue is solved.", sourceRefs: [] });
  assert.ok(resolved.ok);
  assert.ok(collaborationExperienceSourcesValid(h.state(), scope, asset.content));
  assert.ok(collaborationPlanSourcesValid(h.state(), scope, plan));
  assert.equal(collaborationPlanPublicationValid(h.state(), scope, plan), false);
  const refocused = await h.control.decide({ issueId: h.issueId, expectedRevision: resolved.issue.revision,
    decision: "focused_learning", reason: "New evidence raises a later scoped question.", sourceRefs: ["report:dependency"] });
  assert.ok(refocused.ok);
  assert.ok((await h.control.fund({ issueId: h.issueId, expectedRevision: refocused.issue.revision, grantId: "grant:later", allowance })).ok);
  assert.deepEqual(collaborationDependencySourceRefs(h.state(), { scope, issueId: h.issueId, focusRevision: h.focusRevision }), [dependencyId, resultRef]);
  assert.ok(collaborationExperienceSourcesValid(h.state(), scope, asset.content));
  assert.ok(collaborationPlanSourcesValid(h.state(), scope, plan));
  assert.ok(refocused.issue.decision.kind === "focused_learning");
  assert.deepEqual(collaborationDependencySourceRefs(h.state(), { scope, issueId: h.issueId, focusRevision: refocused.issue.decision.revision }), []);
  assert.equal(h.state().activations.length, 0, "source qualification neither promotes a trial nor grants execution authority");
});
