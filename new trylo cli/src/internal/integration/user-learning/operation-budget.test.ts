import assert from "node:assert/strict";
import test from "node:test";
import type { CentralAccountingReservation } from "../../learning/control/central-accounting-contract.js";
import { projectUserOperationBudget, userOperationCallIdentity } from "./operation-budget.js";

const logical = { questionRef: "question:user", sourcePrefixRef: "source:1", step: 1, nextAction: "compare the task-only counterexample" };
const limits = { ownerId: "workspace:1", operationRef: "work:1", maxTotalTokens: 1000, maxCalls: 3 };

function reservation(reservationId: string, usage: "reserved" | "unknown" | number, maxTokens = 400): CentralAccountingReservation {
  const common = { reservationId, owner: { kind: "user_learning" as const, ownerId: limits.ownerId }, maxTokens,
    reservedAt: "2026-11-05T00:00:00.000Z", reservedSequence: 2 };
  return usage === "reserved" ? { ...common, state: "reserved" }
    : { ...common, state: "settled", usage: usage === "unknown" ? { kind: "unknown", reason: "interrupted_after_send" }
      : { kind: "reported", totalTokens: usage } };
}

test("reconstructing the same operation projects its original root charges instead of a fresh allowance", () => {
  const first = userOperationCallIdentity({ ...logical, operationRef: limits.operationRef });
  const second = userOperationCallIdentity({ ...logical, step: 2, operationRef: limits.operationRef });
  const otherOperation = userOperationCallIdentity({ ...logical, operationRef: "work:other" });
  const rows: CentralAccountingReservation[] = [reservation(first.reservationId, 150), reservation(second.reservationId, 225),
    reservation(otherOperation.reservationId, 900), { ...reservation(`${first.namespace}other-owner`, 800),
      owner: { kind: "user_learning", ownerId: "workspace:other" } },
    { ...reservation(`${first.namespace}central`, 800), owner: { kind: "central_deliberation", ownerId: limits.ownerId } }];
  const projection = projectUserOperationBudget({ ...limits, reservations: rows, logicalCall: first });

  assert.deepEqual(projection.spent, { tokens: 375, calls: 2 });
  assert.deepEqual(projection.remaining, { tokens: 625, calls: 1 });
  assert.equal(projection.hasOperationReservation, true);
  assert.equal(projection.hasUncertainOperationReservation, false);
  assert.equal(projection.hasLogicalCallReservation, true);
  assert.deepEqual(projectUserOperationBudget({ ...limits, reservations: structuredClone(rows), logicalCall: first }), projection);
});

test("unknown and in-flight costs keep their maximum reservation while reported zero still consumes a call", () => {
  const rows = [0, 1, 2].map(step => userOperationCallIdentity({ ...logical, step, operationRef: limits.operationRef }));
  const projection = projectUserOperationBudget({ ...limits, reservations: [reservation(rows[0]!.reservationId, 0),
    reservation(rows[1]!.reservationId, "unknown", 400), reservation(rows[2]!.reservationId, "reserved", 300)] });

  assert.deepEqual(projection.spent, { tokens: 700, calls: 3 });
  assert.deepEqual(projection.remaining, { tokens: 300, calls: 0 });
  assert.equal(projection.hasUncertainOperationReservation, true);
  const overrun = projectUserOperationBudget({ ...limits, reservations: [reservation(rows[0]!.reservationId, 1200)] });

  assert.deepEqual(overrun.spent, { tokens: 1200, calls: 1 });
  assert.equal(overrun.remaining.tokens, 0, "an observed overrun is retained, never truncated to its reserved cap");
});

test("no reservation, prior-operation logical dispatch and legacy dispatch have distinct recovery facts", () => {
  const current = userOperationCallIdentity({ ...logical, operationRef: limits.operationRef });
  const previous = userOperationCallIdentity({ ...logical, operationRef: "old-work" });

  assert.notEqual(current.reservationId, previous.reservationId);
  assert.equal(current.logicalCallHash, previous.logicalCallHash);
  assert.deepEqual(projectUserOperationBudget({ ...limits, reservations: [], logicalCall: current }), {
    spent: { tokens: 0, calls: 0 }, remaining: { tokens: 1000, calls: 3 }, hasOperationReservation: false,
    hasUncertainOperationReservation: false, hasLogicalCallReservation: false });
  const prior = projectUserOperationBudget({ ...limits, reservations: [reservation(previous.reservationId, "reserved")], logicalCall: current });

  assert.equal(prior.hasOperationReservation, false);
  assert.equal(prior.hasLogicalCallReservation, true);
  const zero = projectUserOperationBudget({ ...limits, reservations: [reservation(current.reservationId, 0)], logicalCall: current });

  assert.equal(zero.spent.tokens, 0);
  assert.equal(zero.hasOperationReservation, true);
  const legacy = projectUserOperationBudget({ ...limits, reservations: [reservation(current.legacyReservationId, "unknown")], logicalCall: current });

  assert.equal(legacy.hasOperationReservation, false);
  assert.equal(legacy.hasLogicalCallReservation, true);
});
