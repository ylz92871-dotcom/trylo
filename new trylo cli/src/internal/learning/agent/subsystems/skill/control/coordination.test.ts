import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState, normalizeBoardState } from "../../../../control/state.js";
import { centralLearningSpent, type CentralLearningAllowance } from "../../../../control/coordination-contract.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { createSkillCoordination } from "./coordination.js";
import { withSkillCentralFunding } from "../host/funded-provider.js";
import { isCentralLearningWorkResult } from "../../../../control/coordination-parse.js";
import { skillReviewWorkResult } from "./review-result.js";
import { createSkillReviewProcess } from "../review-process.js";

const NOW = "2026-11-03T18:00:00.000Z", scope = "workspace:hermes";
const allowance: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20_000,
  maxCalls: 4, maxSteps: 4, maxPromptChars: 10_000 };
const request: ProviderRequest = { attemptId: "test", model: "fixture", tools: [], messages: [{ role: "user", content: "Learn from the task." }] };

function memory() {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { load: async () => ({ ok: true, state, generation: 0 }), apply: async command => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  return { board, state: () => state };
}

const serviceFor = (h: ReturnType<typeof memory>, enabled = () => true) =>
  createSkillCoordination({ board: h.board, scope, ownerId: "skill-owner", now: () => NOW, enabled });

async function focus(service: ReturnType<typeof serviceFor>, sourceRef = "session:real-turn") {
  const reported = await service.report({ sourceRef, taskId: "real-turn", facts: ["Task execution produced a reusable correction."], evidenceRefs: ["journal:real-turn"] });
  assert.ok(reported.ok);
  const input = { issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    reason: "The existing Hermes review admits this task opportunity.", sourceRefs: [sourceRef], allowance };
  const funded = await service.focus(input);
  assert.ok(funded.ok);
  return { funded, input };
}

async function drain(provider: ProviderPort, signal = new AbortController().signal) {
  for await (const _event of provider.stream(request, signal)) { /* Consume the provider contract through finish. */ }
}

test("a task report is durable without silently funding or running learning", async () => {
  const h = memory(), service = serviceFor(h);
  const report = { sourceRef: "session:one", taskId: "one", facts: ["Observed one task."], evidenceRefs: ["journal:one"] };
  const first = await service.report(report), again = await service.report(report);

  assert.ok(first.ok && again.ok);
  assert.equal(h.state().learningIssues?.length, 1);
  assert.equal(h.state().jobs.length, 0);
  assert.equal(h.state().centralLearningGrants?.length ?? 0, 0);
  assert.ok(normalizeBoardState(h.state()), "skill report survives the canonical snapshot boundary");
});

test("one PA invocation allocation cannot mint another skill purse by focusing a different issue", async () => {
  const h = memory(), service = serviceFor(h);
  const first = await service.report({ sourceRef: "pa-first", taskId: "first", facts: ["First real task."], evidenceRefs: [] });
  const second = await service.report({ sourceRef: "pa-second", taskId: "second", facts: ["Second real task."], evidenceRefs: [] });

  assert.ok(first.ok && second.ok);
  const input = (issue: typeof first.issue) => ({ issueId: issue.issueId, expectedRevision: issue.revision,
    reason: "PA explicitly selected this procedural opportunity.", sourceRefs: [], allowance });
  const allocation = { grantId: "pa-skill:fixed-invocation" };

  assert.ok((await service.focus(input(first.issue), allocation)).ok);
  assert.ok((await service.focus(input(first.issue), allocation)).ok, "exact replay reuses its original allocation");
  const before = JSON.stringify(h.state());

  assert.deepEqual(await service.focus(input(second.issue), allocation), { ok: false, reason: "learning_grant_conflict" });
  assert.equal(JSON.stringify(h.state()), before, "allocation conflict is rejected before changing the second issue");
  assert.equal(h.state().centralLearningGrants?.length, 1);
});

test("central skill work records actual provider costs and native pending refs with one grant", async () => {
  const h = memory(), service = serviceFor(h), { funded, input } = await focus(service);

  assert.ok((await service.focus(input)).ok, "replay cannot allocate another grant");
  let calls = 0;
  const done = await service.run({ issueId: funded.issue.issueId, signal: new AbortController().signal, async worker({ funding }) {
    const provider = withSkillCentralFunding({ async *stream() {
      calls += 1;
      assert.equal(h.state().centralLearningGrants?.[0]?.reservations.at(-1)?.state, "reserved");
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 20, totalTokens: 30,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } }, { funding, newId: () => `call:${calls + 1}` });

    await drain(provider);
    await drain(provider);

    return { kind: "completed", resultRefs: ["hermes:pending:real-id"] };
  } });

  assert.ok(done.ok);
  if (done.ok) assert.equal(done.status, "completed");

  const grant = h.state().centralLearningGrants?.[0];
  assert.ok(grant);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 60, calls: 2, steps: 2 });
  assert.deepEqual(h.state().jobs[0]?.coordination?.resultRefs, ["hermes:pending:real-id"]);
  assert.equal(h.state().centralLearningGrants?.length, 1);
  assert.equal(h.state().learningGrantFacts?.length ?? 0, 0, "v2 work must not also spend the legacy output allowance");
  assert.equal(h.state().assets.length, 0, "native Hermes remains the only skill-content owner");
  assert.ok(normalizeBoardState(h.state()));
});

test("missing or partial provider usage freezes later calls under the original grant", async () => {
  const h = memory(), service = serviceFor(h), { funded } = await focus(service);
  let calls = 0;
  const result = await service.run({ issueId: funded.issue.issueId, signal: new AbortController().signal, async worker({ funding }) {
    const provider = withSkillCentralFunding({ async *stream() {
      calls += 1;
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 2, outputTokens: 3, totalTokens: 5,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      // Transport closes before finish: this lower bound is not a final bill.
    } }, { funding, newId: () => `partial:${calls + 1}` });

    await drain(provider);
    await assert.rejects(drain(provider), /skill_learning_inactive/);
    assert.equal(calls, 1);

    return { kind: "failed", reason: "provider_stream_incomplete" };
  } });

  assert.ok(result.ok);
  const grant = h.state().centralLearningGrants?.[0];
  assert.ok(grant);
  assert.equal(grant.reservations[0]?.usage?.kind, "unknown");
  assert.equal(centralLearningSpent(grant).tokens, grant.reservations[0]?.maxTokens);
});

test("collection withdrawal still settles already incurred usage and cancels the central claim", async () => {
  let enabled = true;
  const h = memory(), service = serviceFor(h, () => enabled), { funded } = await focus(service);
  const done = await service.run({ issueId: funded.issue.issueId, signal: new AbortController().signal, async worker({ funding }) {
    assert.ok((await funding.reserve({ reservationId: "already-started", maxTokens: 100 })).ok);
    enabled = false;
    assert.ok((await funding.settle({ reservationId: "already-started", usage: { kind: "reported", totalTokens: 40 } })).ok);
    return { kind: "completed", resultRefs: ["hermes:pending:staged-before-withdrawal"] };
  } });

  assert.ok(done.ok);
  if (done.ok) assert.equal(done.status, "cancelled");

  assert.equal(h.state().centralLearningGrants?.[0]?.status, "closed");
  assert.equal(centralLearningSpent(h.state().centralLearningGrants![0]!).tokens, 40);
});

test("stale or foreign grants cannot invoke the skill worker", async () => {
  const h = memory(), service = serviceFor(h), { funded } = await focus(service);
  const other = createSkillCoordination({ board: h.board, scope: "workspace:other", ownerId: "other", now: () => NOW });
  let called = false;
  const result = await other.run({ issueId: funded.issue.issueId, signal: new AbortController().signal,
    worker: async () => {
      called = true;
      return { kind: "completed", resultRefs: [] };
    } });

  assert.equal(result.ok, false);
  assert.equal(called, false);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await service.run({ issueId: funded.issue.issueId, signal: cancelled.signal,
    worker: async () => {
      called = true;
      return { kind: "completed", resultRefs: [] };
    } })).ok, false);
  assert.equal(called, false);
});

test("ordinary dispatch consumes at most one existing skill grant and never funds reports", async () => {
  const h = memory(), service = serviceFor(h);
  const report = await service.report({ sourceRef: "unfunded", taskId: "unfunded-turn", facts: ["Only an observed opportunity."], evidenceRefs: [] });

  assert.ok(report.ok);
  let calls = 0;
  const worker = async () => {
    calls += 1;
    return { kind: "completed" as const, resultRefs: ["hermes-pending:skills:one"] };
  };
  const idle = await service.dispatchFunded({ signal: new AbortController().signal, worker });

  assert.ok(idle.ok);
  if (idle.ok) assert.equal(idle.status, "idle");

  assert.equal(calls, 0);
  assert.equal(h.state().centralLearningGrants?.length ?? 0, 0);
  const first = await focus(service, "first-funded"), second = await focus(service, "second-funded");
  const done = await service.dispatchFunded({ signal: new AbortController().signal, worker });

  assert.ok(done.ok);
  if (done.ok) assert.equal(done.issueId, first.funded.issue.issueId);

  assert.equal(calls, 1);
  assert.equal(h.state().centralLearningGrants?.length, 2);
  assert.equal(h.state().jobs.find(job => job.jobId === second.funded.grant.jobId)?.state, "queued");
});

test("funded dispatch respects workspace, active leases and cancellation, then resumes an expired claim without new quota", async () => {
  const h = memory(), service = serviceFor(h), { funded } = await focus(service);
  const claim = await h.board.apply({ type: "coordinate_learning", commandId: "prior-worker-claim", issuedAt: NOW,
    action: { kind: "claim", jobId: funded.grant.jobId, expectedAttempt: 0, claimId: "prior-worker", ownerId: "prior-owner",
      expiresAt: "2026-11-03T18:01:00.000Z" } });

  assert.ok(claim.ok);
  let calls = 0;
  const worker = async () => {
    calls += 1;
    return { kind: "completed" as const, resultRefs: [] };
  };
  const busy = await service.dispatchFunded({ signal: new AbortController().signal, worker });

  assert.ok(busy.ok);
  if (busy.ok) assert.equal(busy.status, "busy");

  const foreign = createSkillCoordination({ board: h.board, scope: "workspace:foreign", ownerId: "foreign", now: () => NOW });
  const other = await foreign.dispatchFunded({ signal: new AbortController().signal, worker });

  assert.ok(other.ok);
  if (other.ok) assert.equal(other.status, "idle");

  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await service.dispatchFunded({ signal: aborted.signal, worker })).ok, false);
  assert.equal(calls, 0);
  const resumed = createSkillCoordination({ board: h.board, scope, ownerId: "resumed", now: () => "2026-11-03T18:02:00.000Z" });
  const done = await resumed.dispatchFunded({ signal: new AbortController().signal, worker });

  assert.ok(done.ok);
  if (done.ok) assert.equal(done.status, "completed");

  assert.equal(calls, 1);
  assert.equal(h.state().centralLearningGrants?.length, 1);
  assert.equal(h.state().centralLearningGrants?.[0]?.grantId, funded.grant.grantId);
  assert.equal(h.state().jobs[0]?.attempt, 2);
});

test("inspect exposes only same-scope skill sources and their matching skill jobs and grants", async () => {
  const h = memory(), service = serviceFor(h), { funded } = await focus(service);
  const pending = await service.report({ sourceRef: "unfunded", taskId: "pending", facts: ["Observed an unfunded task."], evidenceRefs: [] });

  assert.ok(pending.ok);
  if (!pending.ok) return;

  const foreign = createSkillCoordination({ board: h.board, scope: "workspace:foreign", ownerId: "foreign", now: () => NOW });
  const other = await focus(foreign, "foreign-task");
  let command = 0;
  const send = (action: import("../../../../control/coordination-contract.js").CoordinationAction) => h.board.apply({
    type: "coordinate_learning", commandId: `inspect-other:${++command}`, issuedAt: NOW, action });

  assert.ok((await send({ kind: "report", scope, issueId: "other-issue", problemKey: "other-problem",
    report: { reportId: "other-report", source: { subsystem: "method", taskId: "other-task", versionId: "v1" },
      facts: ["A separate subsystem opportunity."], evidenceRefs: ["other-source"] } })).ok);
  const otherRevision = h.state().learningIssues?.find(issue => issue.issueId === "other-issue")?.revision;

  assert.ok(otherRevision !== undefined);
  assert.ok((await send({ kind: "decide", issueId: "other-issue", expectedRevision: otherRevision,
    decision: "focused_learning", reason: "Explicit other-domain decision.", sourceRefs: ["other-source"] })).ok);
  const focusedRevision = h.state().learningIssues?.find(issue => issue.issueId === "other-issue")?.revision;

  assert.ok(focusedRevision !== undefined);
  assert.ok((await send({ kind: "fund", domain: "collaboration", issueId: "other-issue", expectedRevision: focusedRevision,
    grantId: "other-grant", allowance })).ok);
  const result = await service.inspect();
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.deepEqual(result.issues.map(issue => issue.issueId), [funded.issue.issueId, pending.issue.issueId]);
  assert.deepEqual(result.jobs.map(job => job.jobId), [funded.grant.jobId]);
  assert.deepEqual(result.grants.map(grant => grant.grantId), [funded.grant.grantId]);
  assert.deepEqual(await service.inspect(other.funded.issue.issueId), { ok: false, reason: "learning_issue_not_found" });
  assert.deepEqual(await service.inspect("unsafe\nissue"), { ok: false, reason: "invalid_learning_coordination" });
});

test("funded worker failures preserve known Hermes codes and suppress private exception text", async () => {
  for (const [message, expected] of [["hermes_source_journal_unavailable", "hermes_source_journal_unavailable"],
    ["private endpoint credential=synthetic-private-value", "skill_learning_worker_failed"],
    ["hermes_secret_synthetic_private_value", "skill_learning_worker_failed"]]) {
    const h = memory(), service = serviceFor(h), { funded } = await focus(service);
    const result = await service.run({ issueId: funded.issue.issueId, signal: new AbortController().signal,
      worker: async () => { throw new Error(message); } });

    assert.ok(result.ok);
    if (!result.ok) continue;

    assert.deepEqual(result.result, { kind: "failed", reason: expected });
    assert.equal(JSON.stringify(h.state()).includes("synthetic-private-value"), false);
    assert.equal(JSON.stringify(h.state()).includes("synthetic_private_value"), false);
  }
});

test("failed and cancelled skill work retains confirmed partial pending references in the original Board job", async () => {
  for (const kind of ["failed", "cancelled"] as const) {
    const h = memory(), service = serviceFor(h), { funded } = await focus(service, kind);
    const pending = ["hermes-pending:skills:confirmed-partial"];
    const done = await service.run({ issueId: funded.issue.issueId, signal: new AbortController().signal,
      async worker() { return { kind, reason: "hermes_review_execution_incomplete", resultRefs: pending }; } });

    assert.ok(done.ok);
    assert.equal(done.status, kind);
    assert.deepEqual(h.state().jobs[0]?.coordination?.resultRefs, pending);
    assert.equal(h.state().jobs[0]?.state, kind);
    assert.ok(normalizeBoardState(h.state()));
  }
});

test("cancellation after native confirmation retains only pending locators and keeps an existing failure typed as failed", async () => {
  for (const kind of ["completed", "failed"] as const) {
    const h = memory(), service = serviceFor(h), { funded } = await focus(service, kind), controller = new AbortController();
    const done = await service.run({ issueId: funded.issue.issueId, signal: controller.signal, async worker() {
      controller.abort();
      const resultRefs = ["hermes-review:review:staged", "hermes-pending:skills:confirmed-before-cancel"];
      return kind === "completed" ? { kind, resultRefs } : { kind, reason: "hermes_review_release_failed", resultRefs };
    } });

    assert.ok(done.ok);
    assert.equal(done.status, kind === "failed" ? "failed" : "cancelled");
    assert.deepEqual(h.state().jobs[0]?.coordination?.resultRefs, ["hermes-pending:skills:confirmed-before-cancel"]);
  }
});

test("central terminal result compatibility accepts old failures and validates optional partial references", () => {
  for (const kind of ["failed", "cancelled"] as const) {
    assert.equal(isCentralLearningWorkResult({ kind, reason: "original failure" }), true);
    assert.equal(isCentralLearningWorkResult({ kind, reason: "partial failure", resultRefs: ["hermes-pending:skills:confirmed"] }), true);
    for (const resultRefs of [["same", "same"], [""], [17], "pending"]) {
      assert.equal(isCentralLearningWorkResult({ kind, reason: "failure", resultRefs }), false);
    }
    assert.equal(isCentralLearningWorkResult({ kind, reason: "failure", arbitraryPending: "unconfirmed" }), false);
  }
});

test("cancelled native review confirmation reaches the same funded issue and remains pending approval", async () => {
  const h = memory(), service = serviceFor(h), { funded } = await focus(service, "native-partial-chain"), controller = new AbortController();
  let nativeConfirmed = false, released = false;
  const review = createSkillReviewProcess({
    async begin() { return { status: "ready", reviewId: "native-review", prompt: "Official review prompt" }; },
    async finish(_id, execution, cleanupSignal) {
      assert.equal(execution.status, "cancelled");
      assert.equal(cleanupSignal.aborted, false);
      nativeConfirmed = true;
      return { status: "cancelled", candidateId: "native-review", error: "hermes_review_execution_incomplete", pendingIds: ["native-confirmed"] };
    },
    async release() { released = true; },
  });
  const done = await service.run({ issueId: funded.issue.issueId, signal: controller.signal, async worker() {
    const result = await review({ trigger: "implicit" }, async () => {
      controller.abort();
      return { status: "cancelled", answer: "", toolFailures: 0,
        proposals: [{ pendingId: "native-confirmed", name: "release-procedure", action: "patch" }] };
    }, controller.signal);
    return skillReviewWorkResult(result);
  } });

  assert.ok(done.ok);
  assert.equal(done.status, "cancelled");
  assert.equal(nativeConfirmed, true);
  assert.equal(released, true);
  assert.deepEqual(h.state().jobs[0]?.coordination?.resultRefs, ["hermes-pending:skills:native-confirmed"]);
  assert.equal(h.state().centralLearningGrants?.length, 1);
  assert.equal(h.state().assets.length, 0);
  assert.equal(h.state().activations.length, 0);
});
