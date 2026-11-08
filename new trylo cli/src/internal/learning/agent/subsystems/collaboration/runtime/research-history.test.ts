import assert from "node:assert/strict";
import test from "node:test";
import type { BoardStore } from "../../../../control/store-port.js";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { collaborationResourceResultMatches } from "../../../../control/collaboration-resource-relation.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationResourceReceipt } from "../../../../../protocol/collaboration-resource.js";
import { createCollaborationControl } from "../control/index.js";
import { createCollaborationWorker } from "../orchestration/worker.js";
import { createCollaborationRuntimeReceiptWriter } from "./receipts/index.js";
import { createCollaborationResearchRecovery, recoverCollaborationResearch } from "./research-history.js";

const scope = "workspace:research-recovery", NOW = "2026-11-04T00:00:00.000Z";
const unexpected = (): never => { throw new Error("Recovery must not repeat a resource query, build dependencies or publish replacement experience"); };

type Funded = { readonly scope: string; readonly issueId: string; readonly jobId: string; readonly grantId: string };

function memory() {
  let state = emptyBoardState(), now = NOW;
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  return { board, state: () => state, now: () => now, advance() { now = "2026-11-04T00:00:02.000Z"; } };
}

async function fund(h: ReturnType<typeof memory>, key: string, targetScope = scope): Promise<Funded> {
  const control = createCollaborationControl({ board: h.board, now: h.now, ownerId: "seed-owner" });
  const reported = await control.report({ scope: targetScope, problemKey: key, report: { reportId: `report:${key}`,
    source: { teamRunId: "team:recovery", taskId: `task:${key}`, memberId: "worker" },
    facts: ["An existing resource may address the collaboration problem."], evidenceRefs: [] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Examine the reusable resource gap.", sourceRefs: [`report:${key}`] });
  assert.ok(focused.ok);
  const funded = await control.fund({ issueId: focused.issue.issueId, expectedRevision: focused.issue.revision, grantId: `grant:${key}`,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 3, maxSteps: 3, maxPromptChars: 10000 } });
  assert.ok(funded.ok);

  return { scope: targetScope, issueId: focused.issue.issueId, jobId: funded.jobId, grantId: funded.grant.grantId };
}

async function record(h: ReturnType<typeof memory>, funded: Funded, id: string, summary: string, resultRefs: readonly string[], paired = true,
  queryText = `Inspect existing expertise for ${id}`) {
  const writer = createCollaborationRuntimeReceiptWriter({ board: h.board, scope: funded.scope });
  const base = { schemaVersion: 1 as const, ...funded, requestId: id, owner: "expert" as const, query: queryText,
    recordedAt: NOW, boundary: { executionId: `learning:${funded.jobId}`, taskId: funded.issueId, round: 1, role: "collaboration_learning" } };
  const query: CollaborationResourceReceipt = { ...base, phase: "resource_query", receiptId: `${id}:query`, resultRefs: [], summary: "Requested" };
  const result: CollaborationResourceReceipt = { ...base, phase: "resource_result", receiptId: `${id}:result`, resultRefs, summary,
    status: resultRefs.length ? "available" : "empty" };

  assert.ok((await writer.record(query)).ok);

  if (paired) assert.ok((await writer.record(result)).ok);

  return { query, result };
}

test("expired original claim recovers research and legal references under the same job/grant without requery or refund", async () => {
  const h = memory(), funded = await fund(h, "original");

  assert.ok((await h.board.apply({ type: "coordinate_learning", commandId: "seed:claim", issuedAt: NOW,
    action: { kind: "claim", jobId: funded.jobId, expectedAttempt: 0, claimId: "claim:expired", ownerId: "old-owner",
      expiresAt: "2026-11-04T00:00:01.000Z" } })).ok);
  assert.ok((await h.board.apply({ type: "coordinate_learning", commandId: "seed:reserve", issuedAt: NOW,
    action: { kind: "reserve", grantId: funded.grantId, claimId: "claim:expired", reservationId: "collaboration-decision:claim:expired:0", maxTokens: 100 } })).ok);
  const originalQuery = "Inspect existing expertise for the recorded collaboration gap";
  const originalRequest = `collaboration-resource:${contentHashOf(["claim:expired", 0, { kind: "query", owner: "expert", query: originalQuery }])}`;
  const pair = await record(h, funded, originalRequest, "Historical summary mentions invented:do-not-authorize; source body is unavailable.",
    ["resource:actual-source"], true, originalQuery);

  h.advance();
  let calls = 0;
  const worker = createCollaborationWorker({ board: h.board, scope, now: h.now,
    recoverResearch: createCollaborationResearchRecovery({ board: h.board, scope }), context: async () => ({}),
    resources: { query: unexpected }, experienceInput: unexpected, publishExperience: unexpected,
    model: { async decide(input) {
      calls += 1;
      assert.ok(input.knownSourceRefs?.includes(pair.result.receiptId));
      assert.ok(input.knownSourceRefs?.includes("resource:actual-source"));
      assert.ok(!input.knownSourceRefs?.includes("invented:do-not-authorize"));
      assert.match(JSON.stringify(input.material), /summary_only/);
      assert.match(JSON.stringify(input.material), /not_recovered/);
      const budget = await input.funding.inspect();
      assert.ok(budget.ok);
      assert.equal(budget.remaining.tokens, 900, "unknown old billing is not refunded");
      assert.ok((await input.funding.reserve({ reservationId: "paid:resumed", maxTokens: 80 })).ok);
      assert.ok((await input.funding.settle({ reservationId: "paid:resumed", usage: { kind: "reported", totalTokens: 40 } })).ok);

      return { ok: true, action: { kind: "no_change", reason: "The recorded resource evidence is sufficient for the current issue.", sourceRefs: ["resource:actual-source"] } };
    } } });
  const restarted = createCollaborationControl({ board: h.board, worker, now: h.now, ownerId: "restarted-owner" });
  const completed = await restarted.dispatch({ scope });
  assert.ok(completed.ok);
  assert.equal(completed.status, "completed");
  assert.equal(calls, 1);
  assert.equal(h.state().jobs.length, 1);
  assert.equal(h.state().centralLearningGrants!.length, 1);
  const grant = h.state().centralLearningGrants![0]!;
  assert.equal(grant.grantId, funded.grantId);
  assert.equal(h.state().jobs[0]!.attempt, 3, "local recovery relinquishes its lease before the original research worker claims a new segment");
  assert.equal(new Set(grant.reservations.map(item => item.claimId)).size, 2);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 140, calls: 2, steps: 2 });
  assert.equal(h.state().collaborationRuntimeReceipts!.filter(item => item.phase === "resource_query").length, 1);
});

test("only same-grant paired results restore sources; unmatched or foreign facts stay outside authority", async () => {
  const h = memory(), own = await fund(h, "own"), foreign = await fund(h, "foreign", "workspace:foreign");
  const otherGrant = await fund(h, "other-grant");
  const pair = await record(h, own, "own-query", "Own historical finding", ["source:own"]);

  await record(h, own, "pending-query", "Not returned", ["source:pending"], false);
  await record(h, foreign, "foreign-query", "Foreign private finding", ["source:foreign"]);
  await record(h, otherGrant, "other-query", "Other grant finding", ["source:other-grant"]);
  const before = JSON.stringify(h.state()), result = recoverCollaborationResearch(h.state(), own);
  assert.ok(result.ok);
  assert.deepEqual(result.sourceRefs, [pair.result.receiptId, "source:own"]);
  const text = JSON.stringify(result.observations);
  assert.match(text, /"unpairedQueryCount":1/);
  assert.doesNotMatch(text, /Foreign private finding|Other grant finding|source:pending/);
  assert.equal(JSON.stringify(h.state()), before);
  assert.equal(recoverCollaborationResearch(h.state(), { ...own, grantId: otherGrant.grantId }).ok, false);

  for (const mismatch of [{ requestId: "different" }, { query: "different" }, { grantId: otherGrant.grantId },
    { scope: "workspace:foreign" }, { boundary: { ...pair.result.boundary, round: 2 } }]) {
    assert.equal(collaborationResourceResultMatches(pair.query, { ...pair.result, ...mismatch }), false);
  }
});

test("preview budget admits whole items and references, labels missing bodies, and never parses text into sources", async () => {
  const h = memory(), funded = await fund(h, "preview");

  await record(h, funded, "small-query", "A useful historical finding", ["source:small"]);
  await record(h, funded, "long-query", "x".repeat(1500), ["source:long"]);
  const largeRefs = Array.from({ length: 32 }, (_, index) => `source:large:${index}:${"x".repeat(480)}`);

  await record(h, funded, "large-query", "Oversized references must not be silently cut", largeRefs);
  const result = recoverCollaborationResearch(h.state(), funded);
  assert.ok(result.ok);
  assert.ok(JSON.stringify({ observations: result.observations, sourceRefs: result.sourceRefs }).length <= 4000);
  assert.ok(result.sourceRefs.includes("source:small"));
  assert.ok(result.sourceRefs.includes("source:long"));
  assert.ok(largeRefs.every(ref => !result.sourceRefs.includes(ref)));
  const text = JSON.stringify(result.observations);
  assert.match(text, /"omittedItemCount":1/);
  assert.match(text, /"mayBeTruncated":true/);
  assert.match(text, /"sourceBodies":"not_recovered"/);
  assert.match(text, /"currentAvailability":"not_checked"/);
});

test("recovery failure ends the original job before dependency or model spending and withdrawal returns no preview", async () => {
  const h = memory(), funded = await fund(h, "failure");
  const worker = createCollaborationWorker({ board: h.board, scope, now: h.now, context: async () => ({}),
    recoverResearch: async () => ({ ok: false, reason: "research_read_failed" }), prepareDependencies: unexpected,
    model: { decide: unexpected }, resources: { query: unexpected }, experienceInput: unexpected, publishExperience: unexpected });
  const service = createCollaborationControl({ board: h.board, worker, now: h.now, ownerId: "failure-owner" });
  const result = await service.dispatch({ scope });
  assert.ok(result.ok);
  assert.equal(result.status, "failed");
  assert.equal(h.state().centralLearningGrants![0]!.closedReason, "research_read_failed");
  assert.equal(centralLearningSpent(h.state().centralLearningGrants![0]!).calls, 0);
  let enabled = true;
  const recovery = createCollaborationResearchRecovery({ scope, enabled: () => enabled,
    board: { async load() {
      enabled = false;
      return { ok: true, state: h.state(), generation: 0 };
    } } });

  assert.deepEqual(await recovery(funded), { ok: false, reason: "collect_disabled" });
});
