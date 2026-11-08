import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { BoardCommand } from "../../../../control/commands.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createCollaborationControl, type CollaborationCentralWorker, type CentralFundingPort } from "../control/index.js";
import { createCollaborationExperienceStore } from "../experience/index.js";
import { createCollaborationRuntimeReceiptWriter } from "../runtime/receipts/index.js";
import { createCollaborationWorker } from "../orchestration/worker.js";
import { isCollaborationPlan } from "../orchestration/parse.js";
import { createPersonalAgentCollaboration } from "./service.js";

const scope = "workspace:pa-contract", NOW = "2026-11-03T12:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };
const signal = () => new AbortController().signal;

function memory() {
  let state = emptyBoardState(), beforeApply: ((command: BoardCommand) => Promise<void>) | undefined;
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    await beforeApply?.(command);
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  return { board, state: () => state, intercept(hook: typeof beforeApply) { beforeApply = hook; } };
}

const central = (h: ReturnType<typeof memory>, worker?: CollaborationCentralWorker) => createCollaborationControl({
  board: h.board, now: () => NOW, ownerId: "pa-contract-owner", ...(worker === undefined ? {} : { worker }),
});

async function report(control: ReturnType<typeof central>, key: string) {
  const result = await control.report({ scope, problemKey: key, report: { reportId: `report:${key}`,
    source: { teamRunId: "team:actual-boundary", taskId: "task:dependent", memberId: "worker" },
    facts: ["The required source reference was absent."], evidenceRefs: [] } });
  assert.ok(result.ok);
  return result.issue;
}

async function fund(control: ReturnType<typeof central>, key: string) {
  const issue = await report(control, key), decision = await control.decide({ issueId: issue.issueId, expectedRevision: issue.revision,
    decision: "focused_learning", reason: "PA selected a reusable coordination improvement.", sourceRefs: [`report:${key}`] });
  assert.ok(decision.ok);
  const result = await control.fund({ issueId: issue.issueId, expectedRevision: decision.issue.revision, grantId: `grant:${key}`, allowance });
  assert.ok(result.ok);
  return { ...result, focusRevision: decision.issue.revision };
}

function planWorker(h: ReturnType<typeof memory>, measured: { calls: number }) {
  return createCollaborationWorker({ board: h.board, scope, now: () => NOW, context: async () => ({ bounded: true }),
    model: { async decide(input) {
      measured.calls += 1;
      const reserved = await input.funding.reserve({ reservationId: `test-model:${input.claimId}`, maxTokens: 100 });
      assert.ok(reserved.ok);
      assert.equal(reserved.status, "reserved");
      assert.ok((await input.funding.settle({ reservationId: `test-model:${input.claimId}`, usage: { kind: "reported", totalTokens: 37 } })).ok);
      return { ok: true, action: { kind: "propose", familyId: "reference-handoff", title: "Reference handoff trial", summary: "Ask for the original reference before dependent work.",
        sourceRefs: input.issue.reports.map(r => r.reportId), adjustments: [{ memberId: "worker", kind: "handoff", instruction: "Request the original source reference." }], experiences: [], needs: [] } };
    } }, resources: { async query() { throw new Error("This bounded decision does not query a library."); } },
    experienceInput: async () => ({ ok: false, reason: "unexpected_experience" }), publishExperience: async () => ({ ok: false, reason: "unexpected_experience" }),
  });
}

test("PA inspection tolerates exposure-only receipts but rejects actual tool or expert resource revision drift", async () => {
  const h = memory(), control = central(h);
  const seed = await fund(control, "seed-experience");
  const writer = createCollaborationRuntimeReceiptWriter({ board: h.board, scope });
  const store = createCollaborationExperienceStore({ board: h.board, scope, now: () => NOW, recordRuntimeReceipt: writer.record });
  const owner = { kind: "legacy_member" as const, workspace: scope, profileId: "profile:1", memberId: "worker" };
  const experience = await store.publishExperience({ issueId: seed.issue.issueId, owner, familyId: "reference", situation: "A member needs a source.",
    responsibilities: ["Dependent worker"], practice: "Request the original source.", sourceRefs: ["report:seed-experience"] });
  assert.ok(experience.ok);
  const issue = await report(control, "current-problem"), revision = { tool: 1, expert: 1 };
  const pa = createPersonalAgentCollaboration({ control, scope, turnId: "turn:1", allowance, currentResources: async () => ({
    view: { ...revision, receipts: h.state().collaborationRuntimeReceipts }, revision: contentHashOf(revision),
  }) });
  const inspected = await pa.inspect();
  assert.ok(inspected.ok);
  assert.ok((await store.recordLoad({ receiptId: "exposure:1", owner, versionIds: [experience.versionId],
    boundary: { executionId: "execution:1", taskId: "task:1", round: 1, role: "worker" }, recordedAt: NOW })).ok);
  const afterExposure = await pa.inspect();
  assert.ok(afterExposure.ok);
  assert.equal(afterExposure.inspectionId, inspected.inspectionId);

  for (const library of ["tool", "expert"] as const) {
    const before = await pa.inspect();
    assert.ok(before.ok);
    revision[library] += 1;
    assert.deepEqual(await pa.decide({ inspectionId: before.inspectionId, issueId: issue.issueId, expectedRevision: issue.revision,
      decision: "resolved", reason: "The current resource handles this.", sourceRefs: [] }, signal()),
    { ok: false, reason: "collaboration_state_changed_inspect_again" });
  }

  const latest = await pa.inspect();
  assert.ok(latest.ok);
  assert.ok((await pa.decide({ inspectionId: latest.inspectionId, issueId: issue.issueId, expectedRevision: issue.revision,
    decision: "resolved", reason: "The current resource handles this.", sourceRefs: [] }, signal())).ok);
});

test("PA resolved and ordinary execution decisions neither fund learning nor call its worker", async () => {
  for (const decision of ["resolved", "ordinary_execution"] as const) {
    const h = memory();
    let calls = 0;
    const control = central(h, { async run() {
      calls += 1;
      throw new Error("No learning was requested.");
    } });
    const issue = await report(control, decision), pa = createPersonalAgentCollaboration({ control, scope, turnId: decision, allowance,
      currentResources: async () => ({ view: { tools: ["existing"], experts: [] }, revision: "resources:1" }) });
    const inspected = await pa.inspect();
    assert.ok(inspected.ok);
    assert.ok((await pa.decide({ inspectionId: inspected.inspectionId, issueId: issue.issueId, expectedRevision: issue.revision,
      decision, reason: "Normal execution already addresses this.", sourceRefs: [] }, signal())).ok);
    assert.equal(calls, 0);
    assert.equal(h.state().jobs.length, 0);
    assert.equal(h.state().centralLearningGrants?.length ?? 0, 0);
  }
});

test("an existing collaboration dependency yields to independently funded skill work, while a newly run dependency stops this invocation", async () => {
  const h = memory();
  let collaborationCalls = 0, skillCalls = 0;
  const control = central(h, { async run() {
    collaborationCalls++;
    return { kind: "waiting_dependency", dependencies: [{ dependencyId: "existing-expert-request", owner: "expert", correlationRef: "existing-expert-result",
      state: { kind: "waiting", reason: "The original request still awaits approval." } }] };
  } });

  await fund(control, "independent-owner");
  const pa = createPersonalAgentCollaboration({ control, scope, turnId: "yield", allowance,
    currentResources: async () => ({ view: {}, revision: "resources" }),
    focusedLearning: { skill: { async focus() { throw new Error("resume must not focus or fund"); },
      async resume() {
        skillCalls++;
        return { ok: true, status: "completed" };
      } } } });
  const first = await pa.resume(signal());
  assert.ok(first.ok);
  assert.equal(first.status, "waiting_dependency");
  assert.equal(collaborationCalls, 1);
  assert.equal(skillCalls, 0, "a worker already ran in this invocation");
  assert.deepEqual(await pa.resume(signal()), { ok: true, status: "completed" });
  assert.equal(collaborationCalls, 1);
  assert.equal(skillCalls, 1, "an existing wait cannot starve another owner's original work");
  assert.equal(h.state().centralLearningGrants!.length, 1, "resume cannot mint a new collaboration grant");
});

test("busy owners yield without hiding their status, while actual failures and cancellation stop further dispatch", async () => {
  const h = memory(), control = central(h, { async run() { throw new Error("No funded collaboration work exists"); } });
  let later = 0;
  const pa = (status: "busy" | "failed" | "cancelled") => createPersonalAgentCollaboration({ control, scope, turnId: status, allowance,
    currentResources: async () => ({ view: {}, revision: "resources" }), focusedLearning: {
      method: { async focus() { throw new Error("unexpected focus"); }, async resume() { return { ok: true, status }; } },
      skill: { async focus() { throw new Error("unexpected focus"); }, async resume() {
        later++;
        return { ok: true, status: "idle" };
      } },
    } });

  assert.deepEqual(await pa("busy").resume(signal()), { ok: true, status: "busy" });
  assert.equal(later, 1);

  for (const status of ["failed", "cancelled"] as const) {
    assert.deepEqual(await pa(status).resume(signal()), { ok: true, status });
    assert.equal(later, 1);
  }

  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await pa("busy").resume(cancelled.signal), { ok: false, reason: "learning_aborted" });
  assert.equal(later, 1);
});

test("worker publication uses PA decision revision and its real central claim and funding ledger", async () => {
  const h = memory(), measured = { calls: 0 }, control = central(h, planWorker(h, measured)), funded = await fund(control, "publish");

  assert.notEqual(funded.issue.revision, funded.focusRevision);
  const result = await control.dispatch({ scope });
  assert.ok(result.ok);
  assert.equal(result.status, "completed");
  const asset = h.state().assets.find(a => isCollaborationPlan(a.content));
  assert.ok(asset);
  assert.ok(isCollaborationPlan(asset.content));
  assert.equal(asset.content.focusRevision, funded.focusRevision);
  assert.equal(measured.calls, 1);
  assert.deepEqual(centralLearningSpent(h.state().centralLearningGrants![0]!), { tokens: 37, calls: 1, steps: 1 });
  assert.equal(h.state().centralLearningGrants!.length, 1);
  assert.equal(h.state().jobs[0]!.state, "succeeded");
  assert.equal(h.state().proposals[0]!.lifecycle, "evaluating");
  assert.equal(h.state().activations.length, 0);
});

test("shared commit rejects a plan when PA resolves after the publisher precheck", async () => {
  const h = memory(), measured = { calls: 0 }, control = central(h, planWorker(h, measured));
  await fund(control, "resolve-before-commit");
  let rejected = false;
  h.intercept(async command => {
    if (command.type !== "commit_asset" || !isCollaborationPlan(command.content) || rejected) return;
    rejected = true;
    const issue = h.state().learningIssues![0]!;
    assert.ok((await control.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision: "resolved",
      reason: "The original execution has already solved the problem.", sourceRefs: [] })).ok);
  });
  assert.equal((await control.dispatch({ scope })).ok, false);
  assert.equal(rejected, true);
  assert.equal(h.state().assets.length, 0);
  assert.equal(h.state().jobs[0]!.state, "cancelled");
  assert.equal(h.state().jobs[0]!.coordination?.resultRefs, undefined);
  assert.equal(centralLearningSpent(h.state().centralLearningGrants![0]!).tokens, 37);
});

test("a PA focus dispatch stays with its selected issue and an explicit closed issue never falls through to another team job", async () => {
  const h = memory(), invoked: string[] = [], control = central(h, { async run(input) {
    invoked.push(input.issue.issueId);
    return { kind: "completed", resultRefs: [] };
  } });
  const old = await fund(control, "older-team"), selected = await report(control, "selected-team");
  const pa = createPersonalAgentCollaboration({ control, scope, turnId: "turn:selected", allowance,
    currentResources: async () => ({ view: {}, revision: "same-resources" }) });
  const inspected = await pa.inspect();
  assert.ok(inspected.ok);
  const result = await pa.decide({ inspectionId: inspected.inspectionId, issueId: selected.issueId, expectedRevision: selected.revision,
    decision: "focused_learning", reason: "PA selected this team's current issue.", sourceRefs: ["report:selected-team"] }, signal());

  assert.ok(result.ok);
  assert.deepEqual(invoked, [selected.issueId]);
  assert.equal(h.state().jobs.find(j => j.jobId === old.jobId)!.state, "queued");
  const latest = h.state().learningIssues!.find(i => i.issueId === selected.issueId)!;

  assert.ok((await control.decide({ issueId: latest.issueId, expectedRevision: latest.revision, decision: "resolved",
    reason: "Selected issue is now closed.", sourceRefs: [] })).ok);
  const closed = await control.dispatch({ scope, issueId: selected.issueId });
  assert.ok(closed.ok);
  assert.equal(closed.status, "idle");
  assert.deepEqual(invoked, [selected.issueId]);
});

test("PA inspection projects current issue pointers without changing history, but hidden late usage still invalidates its token", async () => {
  const h = memory(), firstFunding: CentralFundingPort[] = [];
  let runs = 0;
  const control = central(h, { async run(input) {
    runs += 1;
    const reservationId = `projection-reservation:${runs}`;

    assert.ok((await input.funding.reserve({ reservationId, maxTokens: 100 })).ok);

    if (runs === 1) firstFunding.push(input.funding);

    assert.ok((await input.funding.settle({ reservationId, usage: runs === 1
      ? { kind: "unknown", reason: "Awaiting the original measured receipt." } : { kind: "reported", totalTokens: 20 } })).ok);

    return { kind: "waiting_dependency", dependencies: [{ dependencyId: `projection-dependency:${runs}`, owner: "expert",
      correlationRef: `projection-result:${runs}`, state: { kind: "waiting", reason: "Creation awaits the user's decision." } }] };
  } });
  const old = await fund(control, "projection-history");
  assert.ok((await control.dispatch({ scope })).ok);
  let issue = h.state().learningIssues!.find(i => i.issueId === old.issue.issueId)!;
  const closed = await control.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision: "ordinary_execution",
    reason: "Current work handles the old request.", sourceRefs: [] });
  assert.ok(closed.ok);
  const focused = await control.decide({ issueId: issue.issueId, expectedRevision: closed.issue.revision, decision: "focused_learning",
    reason: "New observed evidence warrants this later bounded investigation.", sourceRefs: ["report:projection-history"] });
  assert.ok(focused.ok);
  const current = await control.fund({ issueId: issue.issueId, expectedRevision: focused.issue.revision,
    grantId: "grant:projection-current", allowance });
  assert.ok(current.ok);
  assert.ok((await control.dispatch({ scope })).ok);
  await report(control, "separate-unfunded-fact");
  const original = await control.read(scope);
  assert.ok(original.ok);
  assert.equal(original.jobs.length, 2);
  assert.equal(original.grants.length, 2);
  assert.equal(original.dependencies.length, 2);
  const beforeInspect = JSON.stringify(h.state());
  const pa = createPersonalAgentCollaboration({ control, scope, turnId: "projection-turn", allowance,
    currentResources: async () => ({ view: { tools: [] }, revision: "unchanged-catalog" }) });
  const inspected = await pa.inspect();
  assert.ok(inspected.ok);
  assert.deepEqual(inspected.state.jobs.map(j => j.jobId), [current.jobId], "PA context must omit the old unreferenced job");
  assert.deepEqual(inspected.state.grants.map(g => g.grantId), [current.grant.grantId]);
  assert.deepEqual(inspected.state.dependencies.map(d => d.dependencyId), ["projection-dependency:2"]);
  assert.deepEqual(inspected.state.issues, original.issues);
  assert.equal(inspected.state.issues.length, 2);
  assert.deepEqual(inspected.state.jobs[0], original.jobs.find(j => j.jobId === current.jobId));
  assert.deepEqual(inspected.state.grants[0], original.grants.find(g => g.grantId === current.grant.grantId));
  assert.deepEqual("historySummary" in inspected ? inspected.historySummary : undefined,
    { hiddenJobs: 1, hiddenGrants: 1, hiddenDependencies: 1, detailSource: "control.read" });
  assert.equal(JSON.stringify(h.state()), beforeInspect, "inspection must never rewrite the Board ledger or evidence");
  assert.deepEqual(await control.read(scope), original, "the original control read retains complete history");
  assert.ok((await firstFunding[0]!.settle({ reservationId: "projection-reservation:1", usage: { kind: "reported", totalTokens: 7 } })).ok);
  const after = await pa.inspect();
  assert.ok(after.ok);
  assert.deepEqual(after.state, inspected.state);
  assert.notEqual(after.inspectionId, inspected.inspectionId, "hidden historical measurement changes still affect freshness");
  issue = h.state().learningIssues!.find(i => i.issueId === old.issue.issueId)!;
  assert.deepEqual(await pa.decide({ inspectionId: inspected.inspectionId, issueId: issue.issueId, expectedRevision: issue.revision,
    decision: "resolved", reason: "A stale inspection cannot decide this issue.", sourceRefs: [] }, signal()),
  { ok: false, reason: "collaboration_state_changed_inspect_again" });
  const complete = await control.read(scope);
  assert.ok(complete.ok);
  assert.equal(complete.grants.length, 2);
  assert.equal(centralLearningSpent(complete.grants.find(g => g.grantId === old.grant.grantId)!).tokens, 7);
});
