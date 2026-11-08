import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateBudget, streamCostUsd, type IterationBudget } from "./iteration.js";

/**
 * WP09.3 / L07 — the dollar budget.
 *
 * Iterations and output tokens already had ceilings; money did not. The
 * contract: a run states `maxCostUsd` and a pricing pair, every stream's
 * usage is priced by the pure `streamCostUsd`, and `evaluateBudget` ends the
 * turn with an explicit `budget_usd_exhausted` verdict once the accumulated
 * cost reaches the ceiling. Written against the unfixed domain first (red
 * evidence, WP09 交接记录).
 */

const BUDGET: IterationBudget = {
  maxIterations: 32,
  maxCostUsd: 0.5,
};

test("a cost under the ceiling is within budget", () => {
  const verdict = evaluateBudget(
    { iterations: 3, outputTokens: 100, promptTokens: 5_000, costUsd: 0.25 },
    BUDGET,
  );
  assert.equal(verdict.kind, "within_budget");
});

test("a cost at or over the ceiling is an explicit budget_usd_exhausted verdict", () => {
  const at = evaluateBudget(
    { iterations: 3, outputTokens: 100, promptTokens: 5_000, costUsd: 0.5 },
    BUDGET,
  );

  assert.equal(at.kind, "budget_usd_exhausted");

  if (at.kind === "budget_usd_exhausted") {
    assert.equal(at.used, 0.5);
    assert.equal(at.limit, 0.5);
  }
});

test("usage without cost stays within a cost ceiling it never reached", () => {
  // Callers that do not price their streams (every caller that predates the
  // field) never trip the ceiling by accident.
  const verdict = evaluateBudget(
    { iterations: 3, outputTokens: 100, promptTokens: 5_000 },
    BUDGET,
  );
  assert.equal(verdict.kind, "within_budget");
});

test("the output ceiling outranks the cost ceiling", () => {
  const verdict = evaluateBudget(
    { iterations: 3, outputTokens: 2_000, promptTokens: 5_000, costUsd: 9 },
    { ...BUDGET, maxOutputTokens: 1_000 },
  );
  assert.equal(verdict.kind, "output_tokens_exhausted");
});

test("streamCostUsd prices input and output tokens per million", () => {
  const cost = streamCostUsd(
    { inputTokens: 1_000_000, outputTokens: 500_000 },
    { inputPerMTok: 3, outputPerMTok: 15 },
  );
  assert.equal(cost, 3 + 7.5);
});

test("streamCostUsd without pricing is zero, never NaN", () => {
  const cost = streamCostUsd({ inputTokens: 1_000, outputTokens: 1_000 }, undefined);
  assert.equal(cost, 0);
});
