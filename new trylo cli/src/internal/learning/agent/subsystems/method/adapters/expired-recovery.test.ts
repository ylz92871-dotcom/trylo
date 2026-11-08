import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { shortId } from "../../../../domains/shared/hash.js";
import type { MethodCard } from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import { snapshotOf } from "../domain/experience-state.js";
import { createExperienceRuntime } from "../orchestration/experience-runtime.js";
import { pendingExperienceReview } from "../orchestration/experience-review.js";
import { createExperienceStore } from "./experience-store.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { methodFundingIdentity } from "./funding-identity.js";
import { createMethodCentralLearning } from "./central-learning.js";
import { createMethodFocusedLearning } from "./focused-learning.js";
import { recoverExpiredMethodLearning } from "./expired-recovery.js";

const at = "2026-11-05T01:00:00.000Z", scope = "method:expiry-workspace", workspaceId = "method:expiry-assets", versionId = "method:expiry-source";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 24000, maxCalls: 4, maxSteps: 4, maxPromptChars: 12000 };

async function fixture(t: TestContext, confirmed: boolean) {
  const parent = testScratchPath("method-expired-recovery");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  const writer = createMethodBoardWriter(root), store = createExperienceStore(root, () => at);
  const card: MethodCard = { schemaVersion: 1, hint: "Read the full JSON schema before editing its payload.", appliesWhen: { tools: ["read_file"] },
    labels: ["containment"], family: "containment", lineage: { createdFrom: { turnId: "test:origin", beat: 1, reason: "containment" } } };

  assert.ok((await writer.commitCard({ card, versionId, nicheId: nicheOf(card), proposalId: "test:method-proposal", evidenceId: "test:method-evidence",
    writeId: "test:seed-method", sample: "JSON schema editing", observedAt: at })).ok);
  const hypothesis = { id: "range:expiry", versionId, scopeId: "json", proposedSequence: 1,
    predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } };

  await store.append(current => ({ kind: "scope", factId: "test:method-scope", versionId, sequence: current.sequence + 1,
    description: "TEST JSON editing", hypothesis: { ...hypothesis, proposedSequence: current.sequence } }));
  const runtimeOptions = { store, emit: () => {}, correct: async () => {}, revise: async () => {} };
  const runtime = createExperienceRuntime(runtimeOptions);

  for (let index = 0; index < 10; index++) {
    const taskId = `test:use:${index}`, context = { taskId, opportunityId: "schema-edit", situation: "Edit schema-bound JSON", features: { format: "json" } };

    assert.ok((await runtime.context(context)).some(item => item.versionId === versionId));
    const receipt = (await runtime.slot(taskId))?.receipts.find(item => item.versionId === versionId);
    assert.ok(receipt);
    const exposureId = `test:exposure:${index}`;

    assert.ok((await writer.recordUse({ writeId: exposureId, exposureId, versionId, proposalId: "test:method-proposal", turnId: taskId, beat: 1,
      requestId: `test:request:${index}`, scope: "json", observedAt: at, ...(receipt.binding === undefined ? {} : { binding: receipt.binding }) })).ok);
    await runtime.decide({ versionId, scopeId: "json", action: "adopt", reason: "TEST actual method adoption" });
    assert.ok((await writer.recordFeedback({ writeId: `test:feedback:${index}`, exposureId, versionId, turnId: taskId, helped: true, context, observedAt: at })).ok);
  }

  const view = await store.load(), request = pendingExperienceReview(runtimeOptions, view, { versionId, scopeId: "json" });
  assert.ok(request);
  const identity = methodFundingIdentity([], workspaceId, scope, { versionId, scopeId: "json" });
  assert.ok(identity.ok);
  let serial = 0;
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, board => board.apply({ type: "coordinate_learning", commandId: `test:method-expiry:${++serial}`, issuedAt: at, action }));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };

  await act({ kind: "report", scope, issueId: identity.issueId, problemKey: "test:method-expiry", report: { reportId: "test:method-source",
    source: { subsystem: "method", taskId: "test:origin", versionId }, facts: ["scope:json"], evidenceRefs: [request.snapshotId] } });
  await act({ kind: "decide", issueId: identity.issueId, expectedRevision: 1, decision: "focused_learning", reason: "TEST original review", sourceRefs: [request.snapshotId] });
  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "test:method-root", scope,
    unit: "total_model_tokens", limits: { tokens: 50000, calls: 8, steps: 8 }, authorizationRef: "test:method-authorized" } });
  await act({ kind: "fund", domain: "prompt", issueId: identity.issueId, expectedRevision: 2, grantId: identity.grantId, allowance,
    budgetId: "test:method-root", expectedSequence: (await load()).sequence, authorizationRef: "test:method-authorized", planRef: "test:method-plan" });
  const grant = (await load()).centralLearningGrants![0]!;

  await act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId: "test:old-method-owner", ownerId: "test:old-method-owner", expiresAt: "2026-11-05T01:01:00.000Z" });
  await act({ kind: "reserve", grantId: grant.grantId, claimId: "test:old-method-owner", reservationId: shortId("method-review", [request.snapshotId, "test:model"]), maxTokens: 1000 });

  if (confirmed) {
    const snapshot = snapshotOf(view, request.scope);
    await store.append(current => ({ kind: "review", factId: shortId("method-review", [request.snapshotId]), versionId, scopeId: "json",
      sequence: current.sequence + 1, snapshotId: request.snapshotId, evidenceRevisions: snapshot.revisions, contextKey: snapshot.contextKey,
      knownCounterexampleRevisions: [], review: { decision: "core_invalid", score: .9, reason: "TEST confirmed invalid core; missing original exit effect", sources: [versionId] } }));
  }

  let calls = 0;
  const options = (now: string) => ({ boardRoot: root, scope, workspaceId, turnId: "test:recovery-turn", now: () => now, model: "test:model",
    provider: { async *stream() {
      calls++;
      assert.fail("Recovery must not invoke a provider");
    } }, emit: () => {}, authorized: () => true });

  return { load, store, identity, request, options, runtimeOptions, act, calls: () => calls };
}

test("method prepare replays a persisted review's missing local effect and yields its expired purse without another review", async t => {
  const f = await fixture(t, true);
  await createMethodCentralLearning(f.options("2026-11-05T01:02:00.000Z")).prepare({ issueId: f.identity.issueId, authorizedAllowance: allowance }, new AbortController().signal);
  const state = await f.load(), grant = state.centralLearningGrants![0]!;
  assert.equal(grant.claim, undefined);
  assert.equal(grant.status, "open");
  assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
  assert.ok((await f.store.load()).facts.some(item => item.factId === shortId("method-repair-exit", [f.request.snapshotId])));
  assert.equal(grant.reservations.length, 1);
  assert.equal(f.calls(), 0);
});

test("method live owner is untouched and focused resume never repurchases an expired unknown snapshot", async t => {
  const f = await fixture(t, false), before = await f.load();

  await createMethodCentralLearning(f.options("2026-11-05T01:00:01.000Z")).prepare({ issueId: f.identity.issueId, authorizedAllowance: allowance }, new AbortController().signal);
  assert.equal((await f.load()).sequence, before.sequence);
  const resumed = await createMethodFocusedLearning(f.options("2026-11-05T01:02:00.000Z")).resume(new AbortController().signal);

  assert.ok(resumed.ok);
  assert.equal(resumed.status, "waiting_dependency");
  const state = await f.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(grant.claim, undefined);
  assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
  assert.equal(grant.reservations.length, 1);
  assert.equal(f.calls(), 0);
  await createMethodFocusedLearning(f.options("2026-11-05T01:03:00.000Z")).resume(new AbortController().signal);
  assert.equal((await f.load()).sequence, state.sequence);
});

test("method recovery refuses to finish after the source is refocused during a local effect", async t => {
  const f = await fixture(t, true);
  const runtime = { ...f.runtimeOptions, store: { ...f.store, async append(make: Parameters<typeof f.store.append>[0]) {
    const view = await f.store.append(make), state = await f.load(), issue = state.learningIssues!.find(item => item.issueId === f.identity.issueId)!;
    await f.act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "ordinary_execution",
      reason: "TEST source owner changed while effects were materializing", sourceRefs: [f.request.snapshotId] });
    return view;
  } } };
  const result = await recoverExpiredMethodLearning({ ...f.options("2026-11-05T01:02:00.000Z"), runtime }, new AbortController().signal, f.identity.issueId);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "learning_issue_conflict");

  const state = await f.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(grant.status, "closed");
  assert.equal(grant.claim, undefined);
  assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
  assert.equal(state.jobs.find(job => job.jobId === grant.jobId)!.state, "cancelled");
  assert.equal(f.calls(), 0);
});
