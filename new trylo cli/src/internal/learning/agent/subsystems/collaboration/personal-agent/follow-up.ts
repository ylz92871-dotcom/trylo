import type { BoardState } from "../../../../control/state.js";
import type { ExperienceBoundaryReceipt, ExperienceOwner } from "../../../../../protocol/collaboration-experience.js";
import { isCollaborationExperienceContent } from "../experience/parse.js";
import { experienceOwnerFingerprint, liveExperienceAssets } from "../experience/policy.js";
import { collaborationExperienceSourcesValid } from "../experience/provenance.js";
import type { CollaborationEvaluation } from "../domain/evaluation.js";

const DEFAULT_PAGE_SIZE = 8, MAX_PAGE_SIZE = 32;

export type CollaborationFollowUpItem = {
  readonly usageReceiptId: string;
  readonly owner: ExperienceOwner;
  readonly versionIds: readonly string[];
  readonly pendingVersionIds: readonly string[];
  readonly supersededVersionIds: readonly string[];
  readonly issueIds: readonly string[];
  readonly boundary: ExperienceBoundaryReceipt["boundary"];
  readonly recordedAt: string;
  readonly currentTask: boolean;
  readonly evaluations: readonly { readonly versionId: string; readonly evaluation: CollaborationEvaluation }[];
};

export type CollaborationFollowUp = {
  readonly schema: "collaboration-follow-up/v1";
  readonly currentTaskId: string;
  readonly issueId?: string;
  readonly totalPending: number;
  readonly currentTaskPending: number;
  readonly items: readonly CollaborationFollowUpItem[];
  readonly page: {
    readonly limit: number;
    readonly cursor: "start" | "continued" | "invalid";
    readonly omitted: number;
    readonly omittedBefore: number;
    readonly omittedAfter: number;
    readonly nextAfterReceiptId?: string;
  };
};

/** A read model of actual uses, not another work queue. Historical dispatches retain attribution value after a revision. */
export function collaborationFollowUp(state: BoardState, input: {
  readonly scope: string; readonly currentTaskId: string; readonly currentTeamRunId?: string;
  readonly issueId?: string;
  readonly limit?: number; readonly afterReceiptId?: string;
}): CollaborationFollowUp {
  const requested = input.limit ?? DEFAULT_PAGE_SIZE;
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(MAX_PAGE_SIZE, requested)) : DEFAULT_PAGE_SIZE;
  const assets = new Map(state.assets.filter(asset => asset.scope === input.scope && isCollaborationExperienceContent(asset.content)
    && !state.tombstones.some(tombstone => tombstone.entityId === asset.versionId || tombstone.entityId === asset.createdFromProposalId)
    && collaborationExperienceSourcesValid(state, input.scope, asset.content)).map(asset => [asset.versionId, asset]));
  const live = new Set(liveExperienceAssets(state, input.scope).map(asset => asset.versionId));
  const receipts = (state.collaborationRuntimeReceipts ?? []).filter(receipt => receipt.scope === input.scope);
  // Canonical Board validation requires one feedback for the whole exact dispatch version set.
  const feedback = new Set(receipts.filter(receipt => receipt.phase === "use_feedback").map(receipt => receipt.usageReceiptId));
  const dispatched = receipts.filter((receipt): receipt is ExperienceBoundaryReceipt => receipt.phase === "dispatched");
  // A child assignment has its own taskId. Its frozen team-run binding places it within the current PA task.
  const currentTask = (receipt: ExperienceBoundaryReceipt) => receipt.boundary.taskId === input.currentTaskId
    || input.currentTeamRunId !== undefined && receipt.boundary.teamRunId === input.currentTeamRunId;
  // Keep canonical order within each task group. A completed cursor remains valid because it names the original dispatch.
  const ordered = [...dispatched.filter(currentTask), ...dispatched.filter(receipt => !currentTask(receipt))];
  const cursorIndex = input.afterReceiptId === undefined ? -1 : ordered.findIndex(receipt => receipt.receiptId === input.afterReceiptId);
  const cursor = input.afterReceiptId === undefined ? "start" : cursorIndex < 0 ? "invalid" : "continued";
  const pending = ordered.flatMap((receipt, index) => {
    if (feedback.has(receipt.receiptId)) return [];

    const fingerprint = experienceOwnerFingerprint(receipt.owner);
    const applicable = receipt.versionIds.filter(versionId => {
      const asset = assets.get(versionId);
      return asset !== undefined && isCollaborationExperienceContent(asset.content)
        && experienceOwnerFingerprint(asset.content.owner) === fingerprint;
    });

    // A feedback command covers the whole exact version set. A withdrawn/missing component cannot become a partial feedback request.
    if (applicable.length !== receipt.versionIds.length || applicable.length === 0) return [];

    const pendingVersionIds = applicable;
    const issueIds: string[] = [], evaluations: CollaborationFollowUpItem["evaluations"][number][] = [];

    for (const versionId of pendingVersionIds) {
      const asset = assets.get(versionId);
      if (asset === undefined || !isCollaborationExperienceContent(asset.content)) continue;
      if (!issueIds.includes(asset.content.issueId)) issueIds.push(asset.content.issueId);
      if (asset.content.evaluation !== undefined) evaluations.push({ versionId, evaluation: asset.content.evaluation });
    }

    if (input.issueId !== undefined && !issueIds.includes(input.issueId)) return [];

    const item: CollaborationFollowUpItem = { usageReceiptId: receipt.receiptId, owner: receipt.owner,
      versionIds: [...receipt.versionIds], pendingVersionIds, supersededVersionIds: pendingVersionIds.filter(versionId => !live.has(versionId)),
      issueIds, boundary: receipt.boundary, recordedAt: receipt.recordedAt,
      currentTask: currentTask(receipt), evaluations };

    return [{ index, item }];
  });
  const before = cursor === "invalid" ? pending.length : pending.filter(item => item.index <= cursorIndex).length;
  const available = cursor === "invalid" ? [] : pending.filter(item => item.index > cursorIndex);
  const items = available.slice(0, limit).map(value => value.item), omittedAfter = available.length - items.length;

  return structuredClone({ schema: "collaboration-follow-up/v1", currentTaskId: input.currentTaskId,
    ...(input.issueId === undefined ? {} : { issueId: input.issueId }),
    totalPending: pending.length, currentTaskPending: pending.filter(value => value.item.currentTask).length, items,
    page: { limit, cursor, omitted: pending.length - items.length, omittedBefore: before, omittedAfter,
      ...(omittedAfter === 0 ? {} : { nextAfterReceiptId: items[items.length - 1]!.usageReceiptId }) } });
}
