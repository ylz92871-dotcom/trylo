import type { CollaborationRuntimeReceipt } from "../../../../../../protocol/collaboration-resource.js";
import type { ExperienceBoundaryReceipt, ExperienceOwner } from "../../../../../../protocol/collaboration-experience.js";
import { canonicalJson } from "../../../../../control/hash.js";
import { isCollaborationRuntimeReceipt } from "../../../../../control/collaboration-runtime-parse.js";
import type { BoardStore } from "../../../../../control/store-port.js";
import type { BoardState } from "../../../../../control/state.js";
import { experienceOwnerFingerprint } from "../../experience/policy.js";

export type RuntimeReceiptResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type CollaborationRuntimeReceiptPort = { record(receipt: CollaborationRuntimeReceipt): Promise<RuntimeReceiptResult> };

/** Host observations use the existing Board writer and replay identity, never their own journal. */
export function createCollaborationRuntimeReceiptWriter(options: { readonly board: Pick<BoardStore, "apply">;
  readonly scope: string; readonly enabled?: () => boolean }): CollaborationRuntimeReceiptPort {
  return { async record(input) {
    if (options.enabled?.() === false) return { ok: false, reason: "collect_disabled" };
    try {
      const receipt: unknown = JSON.parse(canonicalJson(input));
      if (!isCollaborationRuntimeReceipt(receipt) || receipt.scope !== options.scope) return { ok: false, reason: "runtime_receipt_invalid" };
      if (options.enabled?.() === false) return { ok: false, reason: "collect_disabled" };
      const result = await options.board.apply({ type: "record_collaboration_runtime", commandId: `collaboration-runtime:${receipt.receiptId}`,
        issuedAt: receipt.recordedAt, receipt });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    } catch { return { ok: false, reason: "board_unavailable" }; }
  } };
}

/** These versions were in a configuration, not proven effective. */
export function experienceReceiptsFor(state: BoardState, scope: string, owner: ExperienceOwner): readonly ExperienceBoundaryReceipt[] {
  const fingerprint = experienceOwnerFingerprint(owner);
  return (state.collaborationRuntimeReceipts ?? []).filter((r): r is ExperienceBoundaryReceipt =>
    (r.phase === "loaded" || r.phase === "dispatched") && r.scope === scope && r.ownerFingerprint === fingerprint);
}

export type { CollaborationRuntimeReceipt, ExperienceBoundaryReceipt, ExperienceOwner };
export type { CollaborationResourceReceipt } from "../../../../../../protocol/collaboration-resource.js";
export type { ExperienceUseFeedback } from "../../../../../../protocol/collaboration-experience.js";
