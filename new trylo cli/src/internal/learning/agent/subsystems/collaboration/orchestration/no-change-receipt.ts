import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { fields, text } from "../../../../../validation/json-shape.js";

export type CollaborationNoChangeReceipt = {
  readonly schema: "collaboration-no-change/v1";
  readonly issueId: string; readonly jobId: string; readonly grantId: string; readonly claimId: string;
  readonly reason: string; readonly sourceRefs: readonly string[];
};

const VERSION = "collaboration-stage-outcome/v1";
const ref = (value: unknown): value is string => text(value, 512);

function isReceipt(value: unknown): value is CollaborationNoChangeReceipt {
  return fields(value, ["schema", "issueId", "jobId", "grantId", "claimId", "reason", "sourceRefs"])
    && value.schema === "collaboration-no-change/v1" && [value.issueId, value.jobId, value.grantId, value.claimId].every(ref)
    && text(value.reason, 1600) && Array.isArray(value.sourceRefs) && value.sourceRefs.length > 0
    && value.sourceRefs.length <= 32 && value.sourceRefs.every(ref);
}

/** Preserves the actual admitted no_change response. It is neither a quality judgment nor economic feedback. */
export async function recordCollaborationNoChange(board: Pick<BoardStore, "load" | "apply">, scope: string, issuedAt: string,
  receipt: CollaborationNoChangeReceipt): Promise<{ readonly ok: true; readonly receiptId: string } | { readonly ok: false; readonly reason: string }> {
  if (!isReceipt(receipt)) return { ok: false, reason: "collaboration_no_change_receipt_invalid" };

  const loaded = await board.load();
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const receiptId = `collaboration-no-change:${contentHashOf({ scope, receipt })}`;
  const existing = loaded.state.rewardV2Facts?.find(fact => fact.id === receiptId);
  if (existing !== undefined) return existing.scope === scope && existing.algorithmVersion === VERSION && existing.kind === "learning_decision"
    && existing.payloadJson === canonicalJson(receipt) ? { ok: true, receiptId } : { ok: false, reason: "collaboration_no_change_receipt_conflict" };

  const written = await board.apply({ type: "record_reward_v2_fact", commandId: receiptId, issuedAt,
    expectedSequence: loaded.state.sequence,
    fact: { id: receiptId, scope, algorithmVersion: VERSION, kind: "learning_decision", payloadJson: canonicalJson(receipt) } });

  return written.ok ? { ok: true, receiptId } : { ok: false, reason: written.reason };
}

/** Existing unlabelled completed records stay unknown; only this typed original receipt proves no_change was returned. */
export function readCollaborationNoChange(board: BoardState, scope: string, receiptId: string): CollaborationNoChangeReceipt | undefined {
  const fact = board.rewardV2Facts?.find(item => item.id === receiptId && item.scope === scope
    && item.kind === "learning_decision" && item.algorithmVersion === VERSION);
  if (fact === undefined) return undefined;

  let value: unknown;

  try { value = JSON.parse(fact.payloadJson); }
  catch { return undefined; }

  return isReceipt(value) && receiptId === `collaboration-no-change:${contentHashOf({ scope, receipt: value })}` ? value : undefined;
}
