import assert from "node:assert/strict";
import test from "node:test";
import type { CoordinationAction } from "./coordination-contract.js";
import { centralLearningSpent } from "./coordination-contract.js";
import { isCentralLearningAllowance, isCentralLearningGrantAllowance, isCentralLearningGrant } from "./coordination-parse.js";
import { centralBudgetProjection } from "./central-budget-state.js";
import { emptyBoardState, normalizeBoardState } from "./state.js";
import { reduce } from "./reducer.js";

const scope = "workspace:managed-lifetime", baseTime = "2026-11-05T00:00:00.000Z";

function fixture() {
  let state = emptyBoardState(), serial = 0;
  const send = (action: CoordinationAction, at = baseTime) => {
    const result = reduce(state, { type: "coordinate_learning", commandId: `lifetime:${++serial}`, issuedAt: at, action });
    if (result.ok) state = result.state;
    return result;
  };
  const accept = (action: CoordinationAction, at?: string) => {
    const result = send(action, at);
    assert.ok(result.ok, JSON.stringify(result));
    return result;
  };

  accept({ kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root", scope, unit: "total_model_tokens",
    limits: { tokens: 128, calls: 64, steps: 64 }, authorizationRef: "host:original" } });
  accept({ kind: "report", issueId: "original-issue", scope, problemKey: "ongoing-source", report: { reportId: "original-report",
    source: { subsystem: "method", taskId: "original-task", versionId: "original-source" }, facts: ["original unresolved research"], evidenceRefs: ["evidence:original"] } });
  accept({ kind: "decide", issueId: "original-issue", expectedRevision: 1, decision: "focused_learning", reason: "bounded research", sourceRefs: ["evidence:original"] });
  accept({ kind: "fund", issueId: "original-issue", expectedRevision: 2, grantId: "original-grant", domain: "prompt",
    budgetId: "root", authorizationRef: "host:original", planRef: "original-plan", expectedSequence: state.sequence,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 128, maxCalls: 64, maxSteps: 64, maxPromptChars: 1000 } });
  const jobId = state.centralLearningGrants![0]!.jobId;
  const claim = (id: string, at = baseTime) => send({ kind: "claim", jobId, expectedAttempt: state.jobs[0]!.attempt,
    claimId: id, ownerId: "original-owner", expiresAt: new Date(Date.parse(at) + 1000).toISOString() }, at);
  const finish = (id: string) => accept({ kind: "finish", jobId, claimId: id, result: { kind: "yielded", reason: "confirmed-source-checkpoint" } });

  return { state: () => state, send, accept, claim, finish, jobId };
}

test("a managed original grant extends from call 64 to 65 under the same root without refunding its unknown request", () => {
  const f = fixture();
  assert.ok(f.claim("claim:one").ok);

  for (let call = 1; call <= 64; call++) {
    f.accept({ kind: "reserve", grantId: "original-grant", claimId: "claim:one", reservationId: `request:${call}`, maxTokens: 2 });
    f.accept({ kind: "settle", grantId: "original-grant", reservationId: `request:${call}`, usage: call === 64
      ? { kind: "unknown", reason: "response_lost" } : { kind: "reported", totalTokens: 1 } });
  }

  f.finish("claim:one");
  const spent = centralLearningSpent(f.state().centralLearningGrants![0]!);

  assert.deepEqual(spent, { tokens: 65, calls: 64, steps: 64 });
  f.accept({ kind: "rebudget", grantId: "original-grant", expectedSequence: f.state().sequence,
    limits: spent, authorizationRef: "host:reconcile", planRef: "reconcile" });
  f.accept({ kind: "set_budget_limit", budgetId: "root", expectedSequence: f.state().sequence, changeId: "explicit-increase",
    limits: { tokens: 10000, calls: 1000, steps: 1000 }, authorizationRef: "host:explicit-increase" });
  f.accept({ kind: "rebudget", grantId: "original-grant", expectedSequence: f.state().sequence,
    limits: { tokens: 66, calls: 65, steps: 65 }, authorizationRef: "host:explicit-increase", planRef: "next-original-operation" });
  assert.ok(f.claim("claim:two").ok);
  f.accept({ kind: "reserve", grantId: "original-grant", claimId: "claim:two", reservationId: "request:65", maxTokens: 1 });
  f.accept({ kind: "settle", grantId: "original-grant", reservationId: "request:65", usage: { kind: "reported", totalTokens: 1 } });
  f.finish("claim:two");
  const state = f.state(), grant = state.centralLearningGrants![0]!;

  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(grant.grantId, "original-grant");
  assert.equal(grant.jobId, f.jobId);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 66, calls: 65, steps: 65 });
  assert.deepEqual(grant.reservations[63]!.usage, { kind: "unknown", reason: "response_lost" });
  assert.ok(isCentralLearningGrantAllowance(grant.allowance));
  assert.equal(isCentralLearningAllowance(grant.allowance), false);
  assert.ok(isCentralLearningGrant(grant));
  assert.ok(normalizeBoardState(state));
  assert.deepEqual(centralBudgetProjection(state, "root")!.available, { tokens: 9934, calls: 935, steps: 935 });
  const { budgetId: _budget, authorizationRef: _auth, planRef: _plan, ...independent } = grant;

  assert.equal(isCentralLearningGrant(independent), false, "an old independent purse does not inherit managed lifetime semantics");
});

test("confirmed checkpoint handoffs do not spend the unresolved-claim retry ceiling", () => {
  const f = fixture();
  for (let step = 1; step <= 65; step++) {
    assert.ok(f.claim(`claim:${step}`).ok);
    f.finish(`claim:${step}`);
  }
  assert.equal(f.state().jobs[0]!.attempt, 65);
  assert.equal(f.state().jobs[0]!.maxAttempts, 64);
  assert.deepEqual(centralLearningSpent(f.state().centralLearningGrants![0]!), { tokens: 0, calls: 0, steps: 0 });
  assert.ok(normalizeBoardState(f.state()));
});

test("consecutive unresolved lease takeovers remain bounded and a true failed result stays terminal", () => {
  const f = fixture();
  assert.ok(f.claim("claim:original").ok);

  for (let retry = 1; retry <= 64; retry++) {
    const result = f.claim(`recovery:${retry}`, new Date(Date.parse(baseTime) + retry * 2000).toISOString());
    assert.ok(result.ok);
    assert.equal(f.state().centralLearningGrants![0]!.claim!.recoveryAttempts, retry);
  }

  const rejected = f.claim("recovery:65", new Date(Date.parse(baseTime) + 65 * 2000).toISOString());

  assert.ok(!rejected.ok);
  assert.equal(rejected.reason, "learning_grant_exhausted");
  const failedAt = new Date(Date.parse(baseTime) + 65 * 2000).toISOString();

  f.accept({ kind: "finish", jobId: f.jobId, claimId: "recovery:64", result: { kind: "failed", reason: "confirmed-terminal-failure" } }, failedAt);
  const terminal = f.claim("do-not-reopen", failedAt);
  assert.ok(!terminal.ok);
  assert.equal(terminal.reason, "learning_grant_closed");
  assert.ok(normalizeBoardState(f.state()));
});
