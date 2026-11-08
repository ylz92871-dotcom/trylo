import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateRevealChains } from "./reveal-chains.js";
import { estimateBoundedMean } from "./mean-estimate.js";
import type { BoundedFeedbackUnit } from "./mean-estimate.js";
import { estimateReportedFeedback } from "./reported-estimate.js";

function ones(count: number, batch: boolean): BoundedFeedbackUnit[] {
  return Array.from({ length: count }, (_, index) => ({ unitId: `unit-${index}`, center: 0.5, support: [1, 1],
    registeredAt: batch ? index + 1 : 2 * index + 1,
    reveal: { value: 1, at: batch ? count + index + 1 : 2 * index + 2 } }));
}

test("reveal layout reuses only past exact closes in FIFO order and counts final closes", () => {
  const result = allocateRevealChains([{ unitId: "a", registeredAt: 1, revealedAt: 5 },
    { unitId: "b", registeredAt: 2, revealedAt: 3 }, { unitId: "c", registeredAt: 4, revealedAt: 8 },
    { unitId: "d", registeredAt: 6, revealedAt: 7 }]);

  assert.deepEqual(result.assignments.map(item => item.chainOrdinal), [1, 2, 2, 1]);
  assert.deepEqual(result.chainCounts, [2, 2]);
  assert.equal(result.revealedCount, 4);
  assert.equal(result.pendingCount, 0);
});

test("same 1024 point results retain the frozen visibility study's different chain costs", () => {
  const batch = estimateBoundedMean(ones(1024, true), 0.05);
  const sequential = estimateBoundedMean(ones(1024, false), 0.05);

  assert.equal(batch.chainCount, 1024);
  assert.equal(sequential.chainCount, 1);
  assert.deepEqual(batch.actualMeanSupport, [1, 1]);
  assert.deepEqual(sequential.actualMeanSupport, [1, 1]);
  assert.deepEqual(batch.conditionalMeanBand, [0, 1]);
  assert.ok(Math.abs(sequential.conditionalMeanBand![0] - 0.9382015755798522) < 1e-10);
  assert.equal(sequential.conditionalMeanBand![1], 1);
  assert.equal(sequential.chains[0]!.gridIndex, 1);
  assert.ok(sequential.conditionalMeanBand![0] < sequential.actualMeanSupport![0]);
});

test("external current truth refines support without creating a past source reveal", () => {
  const input = ones(1024, false).map(unit => ({ ...unit, center: 0.99 }));
  const last = input[input.length - 1]!;
  const pending: BoundedFeedbackUnit = { unitId: last.unitId, registeredAt: last.registeredAt, center: last.center, support: [0, 1] };
  const beforeInput = [...input.slice(0, -1), pending];
  const beforeBytes = JSON.stringify(beforeInput);
  const before = estimateBoundedMean(beforeInput, 0.05);
  const after = estimateBoundedMean([...input.slice(0, -1), { ...pending, support: [1, 1] }], 0.05);

  assert.equal(JSON.stringify(beforeInput), beforeBytes);
  assert.equal(before.population, after.population);
  assert.equal(before.chainCount, 1);
  assert.equal(after.chainCount, 1);
  assert.equal(before.observerRevealCount, 1023);
  assert.equal(after.observerRevealCount, 1023);
  assert.equal(after.observerPendingCount, 1);
  assert.equal(after.currentPointSupportCount, 1024);
  assert.deepEqual(before.actualMeanSupport, [1023 / 1024, 1]);
  assert.deepEqual(after.actualMeanSupport, [1, 1]);
  assert.ok(after.chains[0]!.normalizedVariance < before.chains[0]!.normalizedVariance);
  assert.ok(after.conditionalMeanBand![0] > before.conditionalMeanBand![0]);
  assert.ok(after.conditionalMeanBand![0] < 1);
});

test("reported S/F split one budget and learn other-or-never without manufacturing quality", () => {
  const units = ones(1024, false).map(unit => ({ unitId: unit.unitId,
    registeredAt: unit.registeredAt, status: "success" as const, revealedAt: unit.reveal!.at }));
  const success = estimateReportedFeedback(units, 0.05);
  const eta = 0.125;
  const expectedBoundary = 0.5 * (Math.log(1920) / eta + (-Math.log1p(-eta) - eta) / eta * 1024);

  assert.equal(success.residualScale, 0.5);
  assert.equal(success.chains[0]!.normalizedVariance, 1024);
  assert.equal(success.chains[0]!.gridIndex, 2);
  assert.ok(Math.abs(success.chains[0]!.logInverseTailBudget - Math.log(160)) < 1e-12);
  assert.ok(Math.abs(success.totalBoundary - expectedBoundary) < 1e-9);
  assert.ok(Math.abs(success.conditionalMeanBands!.success[0] - (1 - expectedBoundary / 1024)) < 1e-10);
  const other = estimateReportedFeedback(units.map(unit => ({ ...unit, status: "other" })), 0.05);

  assert.deepEqual(other.actualMeanSupport!.otherOrNever, [1, 1]);
  assert.ok(other.conditionalMeanBands!.otherOrNever[0] > 0.8);
  assert.equal(other.interpretation, "reported_channel_only_not_task_quality_or_causal_credit");
  const mixed = estimateReportedFeedback([{ unitId: "o", registeredAt: 1, status: "other", revealedAt: 2 },
    { unitId: "p", registeredAt: 3, status: "pending" }, { unitId: "f", registeredAt: 4, status: "failure", revealedAt: 5 }], 0.05);

  assert.equal(mixed.chainCount, 2);
  assert.deepEqual(mixed.counts, { success: 0, failure: 1, closedOther: 1, pending: 1 });
  assert.deepEqual(mixed.actualMeanSupport!.otherOrNever, [1 / 3, 2 / 3]);
});

test("empty means are undefined and conflicting historical reveal is not silently revised", () => {
  assert.equal(estimateBoundedMean([], 0.05).conditionalMeanBand, null);
  assert.equal(estimateReportedFeedback([], 0.05).actualMeanSupport, null);
  assert.throws(() => estimateBoundedMean([], 0), /feedback_delta/);
  assert.throws(() => estimateBoundedMean([{ unitId: "x", registeredAt: 1, center: 0.5,
    support: [1, 1], reveal: { at: 2, value: 0 } }], 0.05), /feedback_reveal_conflicts/);
  assert.equal(estimateBoundedMean([{ unitId: "x", registeredAt: 1, center: 0.5,
    support: [1, 1], reveal: { at: 1, value: 1 } }], 0.05).observerRevealCount, 1);
  assert.throws(() => estimateReportedFeedback([{ unitId: "x", registeredAt: 1,
    status: "success", revealedAt: 1 }], 0.05), /feedback_report_close_order/);
  assert.throws(() => allocateRevealChains([{ unitId: "x", registeredAt: 2 }, { unitId: "x", registeredAt: 3 }]), /feedback_unit_identity/);
});
