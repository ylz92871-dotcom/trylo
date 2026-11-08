import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatePool, variantOf, withVariant } from "./archive.js";
import { compileSlot } from "../orchestration/compile.js";
import type { VariantRecord } from "../domain/contracts.js";
import { settlementFor } from "./settlement.js";
import { SETTLE_BATCH_MAX, WORKING_LAYER_CAPACITY } from "../../../../control/method-retention-policy.js";

const AT = "2026-10-15T12:00:00.000Z";

function variant(index: number): VariantRecord {
  return variantOf({ versionId: `v${index}`, proposalId: `p${index}`, accounting: [], card: {
    schemaVersion: 1, hint: `method ${index}`, appliesWhen: {}, labels: ["containment"],
    lineage: { createdFrom: { turnId: "seed", beat: 1, reason: "containment" } },
  } });
}

test("working insertion keeps same-niche cards until the working LRU capacity applies", () => {
  let archive: ReadonlyArray<VariantRecord> = [];
  for (let index = 0; index < 10; index += 1) archive = withVariant(archive, variant(index));
  assert.equal(candidatePool(archive).length, 10);
});

test("working LRU evicts the oldest use only, preserving middle/stable cards and their history", () => {
  const working = Array.from({ length: WORKING_LAYER_CAPACITY + 1 }, (_, index) => ({
    ...variant(index), ledger: { ...variant(index).ledger, lastUsedSeq: index + 1 },
  }));
  const archive: VariantRecord[] = [...working,
    { ...variant(900), layer: "middle" }, { ...variant(901), layer: "stable" }];
  const changes = settlementFor(archive, AT);

  assert.deepEqual(changes.map(item => [item.versionId, item.retention]), [["v0", "evicted"]]);
  assert.equal(archive.length, WORKING_LAYER_CAPACITY + 3, "the input/history is immutable");
  const oversized = Array.from({ length: WORKING_LAYER_CAPACITY + 40 }, (_, index) => variant(index));

  assert.equal(settlementFor(oversized, AT).length, SETTLE_BATCH_MAX, "legacy overflow drains in bounded batches");
});

test("legacy settlement keeps bounded middle batches and cannot bypass stable dual gates", () => {
  const eligible = Array.from({ length: SETTLE_BATCH_MAX + 2 }, (_, index) => ({
    ...variant(index), ledger: { ...variant(index).ledger, fieldedCount: 3, helpedCount: 2, lastUsedAt: AT },
  }));

  assert.equal(settlementFor(eligible, AT).length, SETTLE_BATCH_MAX);
  const middle: VariantRecord = { ...variant(50), layer: "middle",
    ledger: { ...variant(50).ledger, fieldedCount: 8, helpedCount: 4, lastUsedAt: "2026-09-01T00:00:00.000Z" } };

  assert.deepEqual(settlementFor([middle], AT), []);
  assert.deepEqual(settlementFor([{ ...middle, ledger: { ...middle.ledger, lastUsedAt: AT, helpedCount: 0 } }], AT), []);
  assert.deepEqual(settlementFor([{ ...middle, ledger: { ...middle.ledger, lastUsedAt: AT } }], AT), []);
});

test("middle receives no ranking bonus, stable and evicted cards never enter the request", () => {
  const first = variant(1);
  const second = variant(2);
  const request = { toolNames: [], currentFamily: undefined, hookLabels: undefined, slotChars: 1200, slotCards: 8 };
  const normal = compileSlot({ ...request, archive: [first, second] }).hints;

  assert.deepEqual(compileSlot({ ...request, archive: [{ ...first, layer: "middle" }, second] }).hints, normal);
  assert.deepEqual(compileSlot({ ...request, archive: [
    { ...first, layer: "stable" }, { ...second, retention: "evicted" },
  ] }).hints, []);
});
