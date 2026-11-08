import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { setCentralLearningBudgetLimitAtRoot } from "../learning-content/central-accounting-management.js";
import { ensureCentralLearningBudget } from "./budget.js";
import type { CentralLearningAllowance } from "../../learning/control/coordination-contract.js";
import { isCentralLearningBudgetRootRef } from "../../learning/control/central-budget-parse.js";

const scope = "workspace:root-reference", issuedAt = "2026-11-05T00:00:00.000Z";
const allowance: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000,
  maxCalls: 4, maxSteps: 4, maxPromptChars: 1000 };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const boardRoot = await mkdtemp(path.join(os.tmpdir(), "trylo-budget-root-"));

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const options = { boardRoot, scope, allowance, authorizationRef: "host:initial-root-authorization", now: () => issuedAt, enabled: () => true };
  const opened = await ensureCentralLearningBudget(options);
  assert.ok(opened.ok);
  const budget = opened.projection.budget;
  const rootRef = { budgetId: budget.budgetId, scope: budget.scope, openedSequence: budget.openedSequence, authorizationRef: budget.authorizationRef };

  assert.deepEqual(opened.rootRef, rootRef);
  const read = async () => {
    const result = await createBoardReader(boardRoot).load();
    assert.ok(result.ok);
    return result.state;
  };

  return { options, rootRef, read };
}

test("an exact original root reference resumes managed total limits without clearing prior spend", async t => {
  const f = await fixture(t);
  const funding = createCentralAccountingFundingAtRoot({ ...f.options, budgetId: f.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: "context:stable" } });

  assert.ok((await funding.reserve({ reservationId: "model:1", maxTokens: 300 })).ok);
  assert.ok((await funding.settle({ reservationId: "model:1", usage: { kind: "reported", totalTokens: 200 } })).ok);
  const changed = await setCentralLearningBudgetLimitAtRoot({ boardRoot: f.options.boardRoot, issuedAt, action: {
    kind: "set_budget_limit", budgetId: f.rootRef.budgetId, expectedSequence: (await f.read()).sequence,
    changeId: "admin:raise-root", limits: { tokens: 2000, calls: 8, steps: 8 }, authorizationRef: "host:explicit-new-total" } });

  assert.ok(changed.ok);
  // This request deliberately retains the initial allowance after explicit root administration.
  const resumed = await ensureCentralLearningBudget({ ...f.options, ...{ rootRef: f.rootRef } });

  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(resumed.projection.budget.limits.tokens, 2000);
  assert.equal(resumed.projection.occupied.tokens, 200);
  assert.equal(resumed.projection.available.tokens, 1800);
  const untouched = await f.read();
  assert.equal(untouched.sequence, changed.state.sequence);
});

test("without a saved root reference new flags still cannot enlarge or reinterpret the existing authorization", async t => {
  const f = await fixture(t);
  const mismatch = await ensureCentralLearningBudget({ ...f.options, allowance: { ...allowance, maxTokens: 2000 } });
  assert.ok(!mismatch.ok);
  assert.equal(mismatch.reason, "central_learning_fixed_budget_mismatch");
  assert.equal((await f.read()).centralLearningBudgets?.length, 1);
});

test("reference mismatch in any immutable field refuses recovery without opening another root", async t => {
  const f = await fixture(t), before = await f.read();

  for (const rootRef of [{ ...f.rootRef, budgetId: "other" }, { ...f.rootRef, scope: "workspace:other" },
    { ...f.rootRef, openedSequence: f.rootRef.openedSequence + 1 }, { ...f.rootRef, authorizationRef: "host:unrelated" }]) {
    const result = await ensureCentralLearningBudget({ ...f.options, ...{ rootRef } });
    assert.ok(!result.ok, "a reference is an exact identity, not a fallback hint");
    assert.equal(result.reason, "learning_budget_binding");
  }

  assert.deepEqual(await f.read(), before);
});

test("a saved reference can never bootstrap a missing root in another Board", async t => {
  const f = await fixture(t), other = await mkdtemp(path.join(os.tmpdir(), "trylo-missing-budget-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const result = await ensureCentralLearningBudget({ ...f.options, boardRoot: other, ...{ rootRef: f.rootRef } });
  assert.ok(!result.ok);
  assert.equal(result.reason, "learning_budget_binding");
  const loaded = await createBoardReader(other).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.sequence, 0);
  assert.equal(loaded.state.centralLearningBudgets, undefined);
});

test("a reference restores only canonical limits and its guard rejects altered identity shapes", async t => {
  const f = await fixture(t);

  assert.ok(isCentralLearningBudgetRootRef(f.rootRef));

  for (const value of [{ ...f.rootRef, limits: { tokens: 999999, calls: 64, steps: 64 } },
    { ...f.rootRef, openedSequence: 0 }, { ...f.rootRef, authorizationRef: "" }, { budgetId: f.rootRef.budgetId }]) {
    assert.equal(isCentralLearningBudgetRootRef(value), false);
  }

  const resumed = await ensureCentralLearningBudget({ ...f.options, rootRef: f.rootRef,
    allowance: { ...allowance, maxTokens: 999999, maxCalls: 64, maxSteps: 64 } });

  assert.ok(resumed.ok);
  assert.deepEqual(resumed.projection.budget.limits, { tokens: 1000, calls: 4, steps: 4 });
  assert.equal((await f.read()).sequence, f.rootRef.openedSequence);
});
