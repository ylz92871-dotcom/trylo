import assert from "node:assert/strict";
import test from "node:test";
import type { CentralAccountingOwner } from "./central-accounting-contract.js";
import type { CoordinationAction } from "./coordination-contract.js";
import { centralBudgetProjection } from "./central-budget-state.js";
import { emptyBoardState, normalizeBoardState, type BoardState } from "./state.js";
import { reduce } from "./reducer.js";
import { isCentralBudgetAction, isCentralLearningBudget } from "./central-budget-parse.js";

const scope = "workspace:central-accounting", issuedAt = "2026-11-05T00:00:00.000Z";
const central: CentralAccountingOwner = { kind: "central_deliberation", ownerId: "central:independent-context" };
const user: CentralAccountingOwner = { kind: "user_learning", ownerId: "user:peer-work" };
const limits = (tokens: number, calls: number, steps = calls) => ({ tokens, calls, steps });

function fixture() {
  let state: BoardState = emptyBoardState(), serial = 0;
  const send = (action: CoordinationAction, id = `accounting:${++serial}`) => {
    const result = reduce(state, { type: "coordinate_learning", commandId: id, issuedAt, action });
    if (result.ok) state = result.state;
    return result;
  };
  const accept = (action: CoordinationAction, id?: string) => {
    const result = send(action, id);
    assert.ok(result.ok, JSON.stringify(result));
    return result;
  };
  const reserve = (id: string, tokens: number, owner = central, expectedSequence = state.sequence) => send({ kind: "reserve_budget_usage",
    budgetId: "root", scope, owner, reservationId: id, maxTokens: tokens, expectedSequence });
  const settle = (id: string, usage: { kind: "reported"; totalTokens: number } | { kind: "unknown"; reason: string }, owner = central) =>
    send({ kind: "settle_budget_usage", budgetId: "root", scope, owner, reservationId: id, usage });
  const change = (id: string, tokens: number, calls: number, expectedSequence = state.sequence) => send({ kind: "set_budget_limit", budgetId: "root",
    expectedSequence, changeId: id, limits: limits(tokens, calls), authorizationRef: "host:explicit-administrator" });

  accept({ kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root", scope,
    unit: "total_model_tokens", limits: limits(1000, 6), authorizationRef: "host:original-authorization" } });

  return { state: () => state, send, accept, reserve, settle, change, projection: () => centralBudgetProjection(state, "root")! };
}

test("central deliberation and peer User Learning compete with actual worker promises in the original root", () => {
  const f = fixture();

  assert.ok(f.reserve("thinking", 250).ok);
  assert.ok(f.reserve("user", 150, user).ok);
  assert.deepEqual(f.projection().occupied, limits(400, 2));
  f.accept({ kind: "report", scope, problemKey: "method", issueId: "method", report: { reportId: "report:method",
    source: { subsystem: "method", taskId: "task", versionId: "method:v1" }, facts: ["new opportunity"], evidenceRefs: ["source:1"] } });
  f.accept({ kind: "decide", issueId: "method", expectedRevision: 1, decision: "focused_learning", reason: "explicit", sourceRefs: ["source:1"] });
  const fund = (tokens: number) => f.send({ kind: "fund", issueId: "method", expectedRevision: 2, grantId: "worker:method", domain: "prompt",
    budgetId: "root", expectedSequence: f.state().sequence, authorizationRef: "host:worker", planRef: "plan:worker",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: tokens, maxCalls: 4, maxSteps: 4, maxPromptChars: 1000 } });
  const tooMuch = fund(601);
  assert.ok(!tooMuch.ok);
  assert.equal(tooMuch.reason, "learning_budget_exhausted");
  assert.ok(fund(600).ok);
  assert.deepEqual(f.projection().available, limits(0, 0));
  const centralBlocked = f.reserve("thinking:2", 1);
  assert.ok(!centralBlocked.ok);
  assert.equal(centralBlocked.reason, "learning_budget_exhausted");
  const userBlocked = f.reserve("user:2", 1, user);
  assert.ok(!userBlocked.ok);
  assert.equal(userBlocked.reason, "learning_budget_exhausted");
  assert.equal(f.state().jobs.length, 1);
  assert.equal(f.state().centralLearningGrants?.length, 1);
  assert.ok(normalizeBoardState(f.state()));
});

test("reservation identity survives later sequences; other owner, scope or cap cannot reuse it", () => {
  const f = fixture(), before = f.state().sequence;

  assert.ok(f.reserve("request", 400).ok);
  assert.ok(f.reserve("other", 100, user).ok);
  const occupied = f.projection().occupied, duplicate = f.reserve("request", 400, central, before);

  assert.ok(duplicate.ok && duplicate.idempotent);
  assert.deepEqual(f.projection().occupied, occupied);

  for (const result of [f.reserve("request", 400, user), f.reserve("request", 401)]) {
    assert.ok(!result.ok);
    assert.equal(result.reason, "learning_budget_conflict");
  }

  const wrongScope = f.send({ kind: "reserve_budget_usage", budgetId: "root", scope: "workspace:other", owner: central,
    reservationId: "request", maxTokens: 400, expectedSequence: f.state().sequence });

  assert.ok(!wrongScope.ok);
  assert.equal(wrongScope.reason, "learning_budget_binding");
  const stale = f.reserve("fresh-with-stale-prefix", 1, central, before);
  assert.ok(!stale.ok);
  assert.equal(stale.reason, "learning_budget_stale");
});

test("pending and unknown never refund, late measured receipts reconcile tokens only", () => {
  const f = fixture();
  assert.ok(f.reserve("request", 400).ok);
  assert.ok(f.settle("request", { kind: "unknown", reason: "crash_after_request" }).ok);
  assert.deepEqual(f.projection().occupied, limits(400, 1));
  const otherOwner = f.settle("request", { kind: "reported", totalTokens: 0 }, user);

  assert.ok(!otherOwner.ok);
  assert.equal(otherOwner.reason, "learning_budget_binding");
  assert.ok(f.settle("request", { kind: "reported", totalTokens: 180 }).ok);
  assert.deepEqual(f.projection().occupied, limits(180, 1));
  const duplicate = f.settle("request", { kind: "reported", totalTokens: 180 });
  assert.ok(duplicate.ok && duplicate.idempotent);
  const rewrite = f.settle("request", { kind: "reported", totalTokens: 0 });
  assert.ok(!rewrite.ok);
  assert.equal(rewrite.reason, "learning_budget_conflict");
});

test("each request consumes an indivisible call and step, regardless of available tokens", () => {
  for (const cap of [limits(1000, 1, 4), limits(1000, 4, 1)]) {
    const f = fixture();
    f.accept({ kind: "set_budget_limit", budgetId: "root", expectedSequence: f.state().sequence,
      changeId: "restrict-one-dimension", limits: cap, authorizationRef: "host:restrict" });
    assert.ok(f.reserve("first", 1).ok);
    assert.ok(f.settle("first", { kind: "reported", totalTokens: 0 }).ok);
    const blocked = f.reserve("second", 1, user);
    assert.ok(!blocked.ok);
    assert.equal(blocked.reason, "learning_budget_exhausted");
    assert.equal(f.projection().available.tokens, 1000);
  }
});

test("real overrun is preserved and holds new direct and worker spending, including after a limit increase", () => {
  const f = fixture();
  assert.ok(f.reserve("overrun", 300).ok);
  assert.ok(f.settle("overrun", { kind: "reported", totalTokens: 1200 }).ok);
  assert.equal(f.projection().occupied.tokens, 1200);
  assert.equal(f.projection().available.tokens, -200);
  assert.equal(f.projection().holdReason, "model_cap_violated");
  assert.ok(normalizeBoardState(f.state()));
  const blocked = f.reserve("next", 1);
  assert.ok(!blocked.ok);
  assert.equal(blocked.reason, "learning_budget_held");
  assert.ok(f.change("admin-increase", 2000, 8).ok);
  assert.equal(f.projection().occupied.tokens, 1200);
  assert.equal(f.projection().status, "held");
});

test("explicit absolute limit management is idempotent and preserves original spent across requests", () => {
  const f = fixture();
  assert.ok(f.reserve("old-turn", 400).ok);
  assert.ok(f.settle("old-turn", { kind: "reported", totalTokens: 250 }).ok);
  const first = f.change("authorization:1", 1500, 8);
  assert.ok(first.ok);
  assert.equal(f.projection().available.tokens, 1250);
  assert.equal(f.projection().budget.authorizationRef, "host:original-authorization");
  assert.ok(f.reserve("new-turn", 300, user).ok);
  const previousSequence = f.state().sequence, repeated = f.change("authorization:1", 1500, 8, 0);

  assert.ok(repeated.ok && repeated.idempotent);
  assert.equal(f.state().sequence, previousSequence);
  assert.deepEqual(f.projection().occupied, limits(550, 2));
  assert.equal(f.projection().budget.limitChanges?.length, 1);
  const changedPayload = f.change("authorization:1", 2500, 8);
  assert.ok(!changedPayload.ok);
  assert.equal(changedPayload.reason, "learning_budget_conflict");
  const belowSpent = f.change("authorization:2", 549, 8);
  assert.ok(!belowSpent.ok);
  assert.equal(belowSpent.reason, "learning_budget_exhausted");
  assert.ok(f.change("authorization:3", 550, 2).ok);
  assert.deepEqual(f.projection().available, limits(0, 0));
  const oldChange = f.change("authorization:1", 1500, 8, 0);
  assert.ok(oldChange.ok && oldChange.idempotent);
  assert.equal(f.projection().budget.limits.tokens, 550, "replaying an old authorization cannot restore its superseded ceiling");
  assert.ok(normalizeBoardState(f.state()));
});

test("old root snapshots remain readable; malformed/new identity and sequence fields fail closed", () => {
  const f = fixture();
  assert.ok(isCentralLearningBudget(f.projection().budget));
  assert.ok(f.reserve("request", 100).ok);
  const state = f.state(), budget = f.projection().budget, reservation = budget.accounting![0]!;

  for (const accounting of [null, [{ ...reservation, usage: { kind: "reported", totalTokens: 0 } }],
    [{ ...reservation, owner: { kind: "prompt", ownerId: "not-a-peer" } }], [reservation, reservation], [{ ...reservation, maxTokens: -1 }]]) {
    assert.equal(normalizeBoardState({ ...state, centralLearningBudgets: [{ ...budget, accounting }] } as BoardState), undefined);
  }

  assert.equal(normalizeBoardState({ ...state, centralLearningBudgets: [{ ...budget,
    accounting: [{ ...reservation, reservedSequence: state.sequence + 1 }] }] }), undefined);
  assert.equal(isCentralBudgetAction({ kind: "set_budget_limit", budgetId: "root", changeId: "admin", expectedSequence: 1,
    limits: limits(1000, 1), authorizationRef: "host:ok", resetSpent: true }), false);
  assert.equal(isCentralBudgetAction({ kind: "reserve_budget_usage", budgetId: "root", scope, expectedSequence: 1,
    owner: central, reservationId: "zero", maxTokens: 0 }), false);
});
