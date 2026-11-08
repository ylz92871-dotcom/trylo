import type { MethodRetention } from "../../../../control/contracts.js";
import type { VariantRecord } from "../domain/contracts.js";
import { nextMethodLayer, SETTLE_BATCH_MAX, WORKING_LAYER_CAPACITY } from "../../../../control/method-retention-policy.js";

/** Local, bounded lifecycle decisions. No layer bonus, model calls, or global reflection. */
export function settlementFor(archive: ReadonlyArray<VariantRecord>, at: string): ReadonlyArray<MethodRetention> {
  const now = Date.parse(at);
  if (!Number.isFinite(now)) return [];

  const changes: MethodRetention[] = [];

  for (const variant of archive) {
    if (changes.length >= SETTLE_BATCH_MAX) break;
    if (variant.retention === "evicted") continue;
    const layer = nextMethodLayer({ layer: variant.layer ?? "working", fielded: variant.ledger.fieldedCount ?? 0,
      helped: variant.ledger.helpedCount ?? 0, lastUsedAt: variant.ledger.lastUsedAt, at });
    if (layer !== undefined) changes.push({ versionId: variant.versionId, layer, retention: "retained", recordedAt: at });
  }

  const promoted = new Set(changes.map(change => change.versionId));
  const working = archive.filter(variant => (variant.layer ?? "working") === "working" &&
    variant.retention !== "evicted" && !promoted.has(variant.versionId));
  const overflow = Math.max(0, working.length - WORKING_LAYER_CAPACITY);
  const oldest = [...working].sort((a, b) => a.ledger.lastUsedSeq - b.ledger.lastUsedSeq);

  for (const variant of oldest.slice(0, overflow)) {
    changes.push({ versionId: variant.versionId, layer: "working", retention: "evicted", recordedAt: at });
  }

  // A legacy oversized archive drains over multiple turns; no maintenance
  // boundary may append an unbounded migration batch.
  return changes.slice(0, SETTLE_BATCH_MAX);
}
