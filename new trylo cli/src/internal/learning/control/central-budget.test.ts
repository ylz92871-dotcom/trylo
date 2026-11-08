import assert from "node:assert/strict";
import test from "node:test";
import type { CoordinationAction, CentralLearningAllowance } from "./coordination-contract.js";
import { centralLearningSpent } from "./coordination-contract.js";
import { centralBudgetProjection } from "./central-budget-state.js";
import { isCentralLearningAllowance, isCentralLearningGrant, isCoordinationAction } from "./coordination-parse.js";
import { emptyBoardState, normalizeBoardState, type BoardState } from "./state.js";
import { reduce } from "./reducer.js";

const issuedAt = "2026-11-04T00:00:00.000Z", scope = "workspace:managed";
const limits = (tokens: number, calls: number, steps = calls) => ({ tokens, calls, steps });
const allowance = (tokens: number, calls: number, steps = calls): CentralLearningAllowance => ({ schemaVersion: 2, unit: "total_model_tokens",
  maxTokens: tokens, maxCalls: calls, maxSteps: steps, maxPromptChars: 10000 });

function fixture() {
  let state = emptyBoardState(), serial = 0;
  const command = (action: CoordinationAction, commandId = `case:${++serial}`) => ({ type: "coordinate_learning" as const, commandId, issuedAt, action });
  const send = (action: CoordinationAction, commandId?: string) => {
    const result = reduce(state, command(action, commandId));
    if (result.ok) state = result.state;
    return result;
  };
  const accept = (action: CoordinationAction, commandId?: string) => {
    const result = send(action, commandId);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    return result;
  };
  const ready = (name: string, domain: "prompt" | "tool" = "prompt") => {
    accept({ kind: "report", scope, issueId: name, problemKey: name, report: { reportId: `report:${name}`,
      source: { subsystem: domain === "prompt" ? "method" : "tool", taskId: `task:${name}`, versionId: `source:${name}` }, facts: ["grounded"], evidenceRefs: [`ref:${name}`] } });
    const issue = state.learningIssues!.find(item => item.issueId === name)!;
    accept({ kind: "decide", issueId: name, expectedRevision: issue.revision, decision: "focused_learning", reason: "explicit bounded opportunity", sourceRefs: [`ref:${name}`] });
  };
  const open = (tokens = 1000, calls = 4) => accept({ kind: "open_budget", expectedSequence: state.sequence,
    budget: { schemaVersion: 1, budgetId: "root", scope, unit: "total_model_tokens", limits: limits(tokens, calls), authorizationRef: "host:root" } });
  const fund = (name: string, tokens: number, calls: number, managed = true, domain: "prompt" | "tool" = "prompt") => {
    const issue = state.learningIssues!.find(item => item.issueId === name)!;
    return send({ kind: "fund", issueId: name, expectedRevision: issue.revision, grantId: `grant:${name}`, domain, allowance: allowance(tokens, calls),
      ...(managed ? { budgetId: "root", authorizationRef: "host:allocation", planRef: "plan:first", expectedSequence: state.sequence } : {}) });
  };
  const grant = (name: string) => state.centralLearningGrants!.find(item => item.grantId === `grant:${name}`)!;
  const claim = (name: string) => {
    const g = grant(name), job = state.jobs.find(item => item.jobId === g.jobId)!;
    accept({ kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId: `claim:${name}`, ownerId: "worker", expiresAt: "2026-11-04T00:01:00.000Z" });
  };
  const reserve = (name: string, tokens = 300) => accept({ kind: "reserve", grantId: grant(name).grantId,
    claimId: `claim:${name}`, reservationId: `reserve:${name}`, maxTokens: tokens });
  const finish = (name: string, kind: "yielded" | "completed") => accept({ kind: "finish", jobId: grant(name).jobId,
    claimId: `claim:${name}`, result: kind === "yielded" ? { kind, reason: "stage_boundary" } : { kind, resultRefs: [] } });
  const rebudget = (name: string, tokens: number, calls: number) => send({ kind: "rebudget", grantId: grant(name).grantId,
    expectedSequence: state.sequence, limits: limits(tokens, calls), authorizationRef: "host:next-stage", planRef: "plan:next" });

  return { state: () => state, command, send, accept, ready, open, fund, grant, claim, reserve, finish, rebudget,
    projection: () => centralBudgetProjection(state, "root")! };
}

test("explicit root rejects new unbound funding while old independent grants stay external", () => {
  const f = fixture();
  f.ready("legacy");
  assert.ok(f.fund("legacy", 900, 2, false).ok);
  f.open();
  f.ready("new");
  const rejected = f.fund("new", 100, 1, false);
  assert.ok(!rejected.ok);
  assert.equal(rejected.reason, "learning_budget_required");
  assert.deepEqual(f.projection().historicalExternalGrantIds, ["grant:legacy"]);
  assert.deepEqual(f.projection().occupied, limits(0, 0));
  const rebound = f.rebudget("legacy", 1000, 3);
  assert.ok(!rebound.ok);
  assert.equal(rebound.reason, "learning_budget_binding");
});

test("cross-domain shared commitments compete for every resource dimension", () => {
  const f = fixture();
  f.open(1000, 3);
  f.ready("a");
  f.ready("b", "tool");
  f.ready("c");
  assert.ok(f.fund("a", 600, 2).ok);
  assert.ok(f.fund("b", 400, 1, true, "tool").ok);
  assert.deepEqual(f.projection().available, limits(0, 0));
  const exhausted = f.fund("c", 1, 1);
  assert.ok(!exhausted.ok);
  assert.equal(exhausted.reason, "learning_budget_exhausted");
});

test("fund and rebudget use Board CAS; matching command replay precedes a stale sequence", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  const action: CoordinationAction = { kind: "fund", issueId: "a", expectedRevision: f.state().learningIssues![0]!.revision,
    grantId: "grant:a", domain: "prompt", allowance: allowance(600, 2), budgetId: "root", authorizationRef: "host:allocation",
    planRef: "plan:cas", expectedSequence: f.state().sequence };
  const first = f.accept(action, "fund:stable"), replay = f.send(action, "fund:stable");

  assert.ok(replay.ok && replay.idempotent);
  assert.equal(replay.state.sequence, first.state.sequence);
  const stale = f.send({ kind: "rebudget", grantId: "grant:a", expectedSequence: first.state.sequence - 1,
    limits: limits(200, 1), authorizationRef: "host:rebudget", planRef: "plan:stale" });

  assert.ok(!stale.ok);
  assert.equal(stale.reason, "learning_budget_stale");
  const conflict = f.send({ ...action, planRef: "plan:changed" }, "fund:stable");
  assert.ok(!conflict.ok);
  assert.equal(conflict.reason, "command_payload_conflict");
});

test("yield retains a lifetime promise until an explicit same-grant reconciliation", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  f.claim("a");
  f.reserve("a");
  f.accept({ kind: "settle", grantId: "grant:a", reservationId: "reserve:a", usage: { kind: "reported", totalTokens: 100 } });
  f.finish("a", "yielded");
  assert.equal(f.projection().occupied.tokens, 600);
  assert.ok(f.rebudget("a", 100, 1).ok);
  assert.equal(f.projection().occupied.tokens, 100);
  assert.ok(f.rebudget("a", 400, 2).ok);
  assert.equal(f.state().centralLearningGrants!.length, 1);
  assert.deepEqual(centralLearningSpent(f.grant("a")), limits(100, 1));
});

test("a confirmed same-grant prompt handoff retains original charges and financial limits", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  f.claim("a");
  const handoff = (): CoordinationAction => ({ kind: "rebudget", grantId: "grant:a", expectedSequence: f.state().sequence,
    limits: limits(600, 2), maxPromptChars: 100000, authorizationRef: "host:larger-context", planRef: "plan:continue-original-read" });
  const active = f.send(handoff());
  assert.ok(!active.ok);
  assert.equal(active.reason, "learning_grant_unsettled");
  f.reserve("a");
  f.accept({ kind: "settle", grantId: "grant:a", reservationId: "reserve:a",
    usage: { kind: "reported", totalTokens: 100 } });
  f.finish("a", "yielded");
  const reservations = f.grant("a").reservations, occupied = f.projection().occupied;
  const changed = f.send(handoff());
  assert.ok(changed.ok, JSON.stringify(changed));
  assert.equal(f.state().centralLearningGrants!.length, 1);
  assert.equal(f.grant("a").allowance.maxPromptChars, 100000);
  assert.deepEqual(f.grant("a").reservations, reservations);
  assert.deepEqual(f.projection().occupied, occupied);
  assert.deepEqual(centralLearningSpent(f.grant("a")), limits(100, 1));
  assert.ok(normalizeBoardState(f.state()));
  assert.ok(f.rebudget("a", 600, 2).ok);
  assert.equal(f.grant("a").allowance.maxPromptChars, 100000,
    "old commands without a prompt field preserve the current context allowance");
});

test("live claims and reserved or unknown costs cannot be refunded", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  f.claim("a");
  const active = f.rebudget("a", 0, 0);
  assert.ok(!active.ok);
  assert.equal(active.reason, "learning_grant_unsettled");
  f.reserve("a");
  f.finish("a", "yielded");
  const refund = f.rebudget("a", 299, 1);
  assert.ok(!refund.ok);
  assert.equal(refund.reason, "learning_budget_exhausted");
  assert.ok(f.rebudget("a", 300, 1).ok);
  assert.equal(f.projection().occupied.tokens, 300);
});

test("closed unknown stays charged and late measured usage releases only its confirmed difference", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  f.claim("a");
  f.reserve("a");
  f.finish("a", "completed");
  assert.equal(f.projection().occupied.tokens, 300);
  f.accept({ kind: "settle", grantId: "grant:a", reservationId: "reserve:a", usage: { kind: "reported", totalTokens: 120 } });
  assert.equal(f.projection().occupied.tokens, 120);
  assert.equal(f.projection().available.tokens, 880);
});

test("a closed child overrun stays charged without freezing unrelated root surplus", () => {
  const f = fixture();
  f.open(10000, 10);
  f.ready("a");
  f.ready("b", "tool");
  f.ready("c");
  assert.ok(f.fund("a", 600, 2).ok);
  assert.ok(f.fund("b", 400, 2, true, "tool").ok);
  f.claim("a");
  f.reserve("a");
  f.accept({ kind: "settle", grantId: "grant:a", reservationId: "reserve:a", usage: { kind: "reported", totalTokens: 301 } });
  assert.equal(f.grant("a").closedReason, "model_token_overrun");
  assert.equal(centralLearningSpent(f.grant("a")).tokens, 301);
  assert.equal(f.projection().status, "available");
  assert.equal(f.projection().occupied.tokens, 701);
  assert.ok(f.fund("c", 1, 1).ok);
  assert.ok(f.rebudget("b", 0, 0).ok);
  assert.ok(isCentralLearningGrant(f.grant("b")));
  assert.ok(normalizeBoardState(f.state()));
  assert.ok(f.rebudget("b", 1, 1).ok);
  const closed = f.send({ kind: "reserve", grantId: "grant:a", claimId: "claim:a", reservationId: "late", maxTokens: 1 });

  assert.ok(!closed.ok);
  assert.equal(closed.reason, "learning_grant_closed");
});

test("zero exhausted caps are managed persistence only; fund still requires a positive allowance", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  assert.ok(f.rebudget("a", 0, 0).ok);
  assert.equal(isCentralLearningAllowance(f.grant("a").allowance), false);
  assert.equal(isCentralLearningGrant(f.grant("a")), true);
  const { budgetId: _budget, authorizationRef: _authorization, planRef: _plan, ...independent } = f.grant("a");
  assert.equal(isCentralLearningGrant(independent), false);
  assert.equal(isCoordinationAction({ kind: "fund", issueId: "a", expectedRevision: 1, grantId: "zero", allowance: allowance(0, 0) }), false);
});

test("root identity cannot be refreshed by a new ID and malformed snapshot ownership is rejected", () => {
  const f = fixture();
  f.open();
  const second = f.send({ kind: "open_budget", expectedSequence: f.state().sequence,
    budget: { schemaVersion: 1, budgetId: "reset", scope, unit: "total_model_tokens", limits: limits(1000, 4), authorizationRef: "host:reset" } });
  assert.ok(!second.ok);
  assert.equal(second.reason, "learning_budget_conflict");
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  const bad: BoardState = { ...f.state(), centralLearningBudgets: [] };
  assert.equal(normalizeBoardState(bad), undefined);
});

test("calls and steps independently block funding even when token capacity remains", () => {
  for (const constrained of ["calls", "steps"] as const) {
    const f = fixture();
    f.accept({ kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root", scope,
      unit: "total_model_tokens", limits: { tokens: 1000, calls: constrained === "calls" ? 1 : 4, steps: constrained === "steps" ? 1 : 4 }, authorizationRef: "host:root" } });
    f.ready("a");
    f.ready("b", "tool");
    assert.ok(f.fund("a", 100, 1).ok);
    assert.equal(f.projection().available.tokens, 900);
    assert.equal(f.projection().available[constrained], 0);
    const rejected = f.fund("b", 100, 1, true, "tool");
    assert.ok(!rejected.ok);
    assert.equal(rejected.reason, "learning_budget_exhausted");
  }
});

test("quiet financial close releases unspent commitment without resolving the learning issue", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  const issueBefore = f.state().learningIssues!.find(item => item.issueId === "a")!;
  const close: CoordinationAction = { kind: "close_investment", grantId: "grant:a", expectedSequence: f.state().sequence,
    reason: "another opportunity now has higher marginal value", authorizationRef: "host:stop", planRef: "plan:stop" };
  const closed = f.accept(close, "close:a");

  assert.deepEqual(f.state().learningIssues!.find(item => item.issueId === "a"), issueBefore);
  assert.equal(f.grant("a").status, "closed");
  assert.equal(f.grant("a").closedReason, close.reason);
  assert.equal(f.state().jobs.find(item => item.jobId === f.grant("a").jobId)!.state, "cancelled");
  assert.equal(f.projection().occupied.tokens, 0);
  const replay = f.send(close, "close:a");
  assert.ok(replay.ok && replay.idempotent);
  assert.equal(replay.state.sequence, closed.state.sequence);
  const again = f.send({ ...close, expectedSequence: f.state().sequence, reason: "replace closure reason" });

  assert.ok(!again.ok);
  assert.equal(again.reason, "learning_grant_closed");
  assert.equal(f.grant("a").closedReason, close.reason);
});

test("financial close revokes a live claim while preserving charged reservations and late settlement", () => {
  const f = fixture();
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  f.claim("a");
  f.reserve("a");
  f.accept({ kind: "close_investment", grantId: "grant:a", expectedSequence: f.state().sequence,
    reason: "stop further investment", authorizationRef: "host:stop", planRef: "plan:stop" });
  assert.equal(f.grant("a").claim, undefined);
  assert.equal(f.grant("a").reservations[0]!.state, "reserved");
  assert.equal(f.grant("a").reservations[0]!.usage, undefined);
  assert.equal(f.projection().occupied.tokens, 300);
  const blocked = f.send({ kind: "reserve", grantId: "grant:a", claimId: "claim:a", reservationId: "late-new-call", maxTokens: 10 });

  assert.ok(!blocked.ok);
  assert.equal(blocked.reason, "learning_grant_closed");
  f.accept({ kind: "settle", grantId: "grant:a", reservationId: "reserve:a", usage: { kind: "reported", totalTokens: 120 } });
  assert.equal(f.projection().occupied.tokens, 120);
  assert.equal(f.grant("a").status, "closed");
  assert.equal(f.state().learningIssues!.find(item => item.issueId === "a")!.decision.kind, "focused_learning");
});

test("financial close requires managed ownership and CAS and cannot erase an overrun closure", () => {
  const f = fixture();
  f.ready("legacy");
  assert.ok(f.fund("legacy", 100, 1, false).ok);
  f.open();
  f.ready("a");
  assert.ok(f.fund("a", 600, 2).ok);
  const close = (name: string, expectedSequence = f.state().sequence): CoordinationAction => ({ kind: "close_investment", grantId: `grant:${name}`,
    expectedSequence, reason: "end future funding", authorizationRef: "host:stop", planRef: "plan:stop" });
  const external = f.send(close("legacy"));
  assert.ok(!external.ok);
  assert.equal(external.reason, "learning_budget_binding");
  const stale = f.send(close("a", f.state().sequence - 1));
  assert.ok(!stale.ok);
  assert.equal(stale.reason, "learning_budget_stale");
  f.claim("a");
  f.reserve("a");
  f.accept({ kind: "settle", grantId: "grant:a", reservationId: "reserve:a", usage: { kind: "reported", totalTokens: 301 } });
  const alreadyClosed = f.send(close("a"));
  assert.ok(!alreadyClosed.ok);
  assert.equal(alreadyClosed.reason, "learning_grant_closed");
  assert.equal(f.grant("a").closedReason, "model_token_overrun");
  assert.equal(centralLearningSpent(f.grant("a")).tokens, 301);
  assert.equal(f.projection().status, "available");
});
