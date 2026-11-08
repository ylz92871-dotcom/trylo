import type { SetMethodRetentionCommand } from "./commands.js";
import { fail, nextSeq, succeed, type ReduceResult } from "./result.js";
import type { BoardState } from "./state.js";
import { isMethodRetention } from "./contracts.js";
import { nextMethodLayer } from "./method-retention-policy.js";
import { methodUsageOf } from "./method-usage.js";

export function applySetMethodRetention(state: BoardState, command: SetMethodRetentionCommand): ReduceResult {
  const record = command.record;
  if (!isMethodRetention(record)) return fail(state, "invalid_method_retention", command.commandId);

  if (!state.assets.some(asset => asset.versionId === record.versionId)) {
    return fail(state, "asset_not_found", record.versionId);
  }

  const previous = state.methodRetentions?.find(item => item.versionId === record.versionId);
  const before = previous?.layer ?? "working";
  const usage = methodUsageOf(state).get(record.versionId);
  const next = nextMethodLayer({ layer: before, fielded: usage?.turns.size ?? 0,
    helped: usage?.helpedTurns.size ?? 0, lastUsedAt: usage?.lastUsedAt, at: record.recordedAt });
  const legalLayer = record.layer === next;
  const eviction = before === "working" && record.layer === "working" && record.retention === "evicted";
  if (previous?.retention === "evicted" || (!eviction && (!legalLayer || record.retention !== "retained")) ||
      typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) {
    return fail(state, "invalid_method_retention", record.versionId);
  }

  return succeed(state, command.commandId, [{
    type: "method_retention_changed", sequence: nextSeq(state), commandId: command.commandId,
    occurredAt: command.issuedAt, record,
  }], { methodRetentions: [...(state.methodRetentions ?? []).filter(item => item.versionId !== record.versionId), record] });
}
