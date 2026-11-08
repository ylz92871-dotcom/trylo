import type { BoardState } from "../../../../control/state.js";
import { collaborationPlanSourcesValid, isCollaborationPlan } from "../orchestration/parse.js";
import type { CollaborationPlan } from "../orchestration/contracts.js";

export const COLLABORATION_PLAN_VIEW_LIMIT = 8;

export type CollaborationPlanProjectionInput = { readonly scope: string; readonly issueId?: string; readonly limit?: number };

export type CollaborationPlanProjection = {
  readonly items: readonly { readonly versionId: string; readonly content: CollaborationPlan }[];
  /** Complete qualified scope set, independent of issue selection and view limits; host freshness only. */
  readonly eligibleVersionIds: readonly string[];
  readonly summary: { readonly status: "available"; readonly availableProposalCount: number; readonly matchingProposalCount: number;
    readonly shownProposalCount: number; readonly omittedProposalCount: number; readonly unrelatedProposalCount: number; readonly note: string };
};

/** Source-valid readable proposals, never adoption or a queue of actions to execute. */
export function collaborationPlanProjection(state: BoardState, input: CollaborationPlanProjectionInput): CollaborationPlanProjection {
  const qualified = state.assets.flatMap(asset => asset.scope !== input.scope || !isCollaborationPlan(asset.content)
    || !collaborationPlanSourcesValid(state, input.scope, asset.content)
    || state.tombstones.some(tombstone => tombstone.entityId === asset.versionId || tombstone.entityId === asset.createdFromProposalId)
    ? [] : [{ versionId: asset.versionId, content: asset.content }]);
  const matching = input.issueId === undefined ? qualified : qualified.filter(plan => plan.content.issueId === input.issueId);
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(COLLABORATION_PLAN_VIEW_LIMIT, input.limit!)) : COLLABORATION_PLAN_VIEW_LIMIT;
  const items = matching.slice(-limit);

  return { items: structuredClone(items), eligibleVersionIds: [...new Set(qualified.map(plan => plan.versionId))].sort(),
    summary: { status: "available", availableProposalCount: qualified.length, matchingProposalCount: matching.length,
      shownProposalCount: items.length, omittedProposalCount: matching.length - items.length, unrelatedProposalCount: qualified.length - matching.length,
      note: "Available source-valid proposals only. Counts do not imply pending work, adoption or effectiveness; hidden proposals remain in the complete freshness revision." } };
}
