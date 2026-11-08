import type { BoardState } from "../../../../control/state.js";
import type { ExperienceBoundaryReceipt, ExperienceUseFeedback } from "../../../../../protocol/collaboration-experience.js";
import type { CollaborationExperienceContent } from "./contracts.js";
import { isCollaborationExperienceContent } from "./parse.js";
import { experienceOwnerFingerprint, liveExperienceAssets } from "./policy.js";
import { collaborationExperienceSourcesValid } from "./provenance.js";

const DEFAULT_LIMIT = 2, MAX_LIMIT = 4, USES_PER_VERSION = 3, REFS_PER_OBSERVATION = 4;

type Observation = NonNullable<ExperienceUseFeedback["assessments"]>[number]["observations"][number];

/** Outcome and summary describe PA's whole-dispatch claim; only assessment is specific to this item version. */
type HistoryFeedback = Pick<ExperienceUseFeedback, "receiptId" | "usageReceiptId" | "summary" | "outcome" | "recordedAt"> & {
  readonly wholeDispatchVersionIds: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly omittedSourceRefs: number;
  readonly assessment?: {
    readonly diagnosis: NonNullable<ExperienceUseFeedback["assessments"]>[number]["diagnosis"];
    readonly observations: readonly (Pick<Observation, "expectationId" | "result"> & {
      readonly sourceRefs: readonly string[]; readonly omittedSourceRefs: number;
    })[];
  };
};

type HistoryUse = {
  readonly dispatch: Pick<ExperienceBoundaryReceipt, "receiptId" | "boundary" | "recordedAt" | "versionIds">;
} & ({ readonly feedbackState: "not_yet_assessed"; readonly feedback?: never }
  | { readonly feedbackState: "pa_claim_recorded"; readonly feedback: HistoryFeedback });

export type CollaborationTrialHistoryItem = {
  readonly versionId: string;
  readonly familyId: string;
  readonly owner: CollaborationExperienceContent["owner"];
  readonly status: "current" | "historical";
  readonly practice: string;
  readonly evaluation?: CollaborationExperienceContent["evaluation"];
  readonly uses: readonly HistoryUse[];
  readonly omittedUses: number;
};

export type CollaborationTrialHistory = {
  readonly schema: "collaboration-trial-history/v1";
  readonly issueId: string;
  readonly attribution: "observational_pa_claims";
  readonly items: readonly CollaborationTrialHistoryItem[];
  readonly omittedVersions: number;
};

function projectFeedback(feedback: ExperienceUseFeedback, versionId: string): HistoryFeedback {
  const assessment = feedback.assessments?.find(item => item.versionId === versionId);
  return { receiptId: feedback.receiptId, usageReceiptId: feedback.usageReceiptId, wholeDispatchVersionIds: [...feedback.versionIds],
    summary: feedback.summary, outcome: feedback.outcome, recordedAt: feedback.recordedAt,
    sourceRefs: feedback.sourceRefs.slice(0, REFS_PER_OBSERVATION),
    omittedSourceRefs: Math.max(0, feedback.sourceRefs.length - REFS_PER_OBSERVATION),
    ...(assessment === undefined ? {} : { assessment: { diagnosis: assessment.diagnosis,
      observations: assessment.observations.map(observation => ({ expectationId: observation.expectationId, result: observation.result,
        sourceRefs: observation.sourceRefs.slice(0, REFS_PER_OBSERVATION),
        omittedSourceRefs: Math.max(0, observation.sourceRefs.length - REFS_PER_OBSERVATION) })) } }) };
}

/** Learning context only: no writer, causal verdict, source authorization or implicit revision. */
export function collaborationTrialHistory(state: BoardState, input: {
  readonly scope: string; readonly issueId: string; readonly limit?: number; readonly maxChars?: number;
}): CollaborationTrialHistory {
  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(MAX_LIMIT, requested)) : DEFAULT_LIMIT;
  const maxChars = Number.isSafeInteger(input.maxChars) ? Math.max(1000, Math.min(20000, input.maxChars!)) : 12000;
  const eligible = state.assets.flatMap(asset => {
    const content = asset.content;
    if (asset.scope !== input.scope || !isCollaborationExperienceContent(content) || content.issueId !== input.issueId
      || state.tombstones.some(item => item.entityId === asset.versionId || item.entityId === asset.createdFromProposalId)
      || !collaborationExperienceSourcesValid(state, input.scope, content)) return [];
    return [{ versionId: asset.versionId, content }];
  });
  const current = new Set(liveExperienceAssets(state, input.scope).map(asset => asset.versionId));
  const receipts = (state.collaborationRuntimeReceipts ?? []).filter(receipt => receipt.scope === input.scope);
  const feedback = new Map(receipts.filter((receipt): receipt is ExperienceUseFeedback => receipt.phase === "use_feedback")
    .map(receipt => [receipt.usageReceiptId, receipt]));
  const candidates = eligible.slice().reverse().slice(0, limit).map(({ versionId, content }): CollaborationTrialHistoryItem => {
    const fingerprint = experienceOwnerFingerprint(content.owner);
    const uses = receipts.filter((receipt): receipt is ExperienceBoundaryReceipt => receipt.phase === "dispatched"
      && receipt.versionIds.includes(versionId) && experienceOwnerFingerprint(receipt.owner) === fingerprint);

    return { versionId, familyId: content.familyId, owner: content.owner,
      status: current.has(versionId) ? "current" : "historical", practice: content.practice,
      ...(content.evaluation === undefined ? {} : { evaluation: content.evaluation }),
      uses: uses.slice(-USES_PER_VERSION).reverse().map((dispatch): HistoryUse => {
        const response = feedback.get(dispatch.receiptId);
        return { dispatch: { receiptId: dispatch.receiptId, boundary: dispatch.boundary,
          recordedAt: dispatch.recordedAt, versionIds: [...dispatch.versionIds] },
          ...(response === undefined ? { feedbackState: "not_yet_assessed" }
            : { feedbackState: "pa_claim_recorded", feedback: projectFeedback(response, versionId) }) };
      }), omittedUses: Math.max(0, uses.length - USES_PER_VERSION) };
  });
  const items: CollaborationTrialHistoryItem[] = [];
  const result: CollaborationTrialHistory = { schema: "collaboration-trial-history/v1", issueId: input.issueId,
    attribution: "observational_pa_claims", items, omittedVersions: eligible.length };

  // Admit complete version metadata before its uses. Oversized feedback is omitted whole, never clipped into a different claim.
  for (const candidate of candidates) {
    const item = { ...candidate, uses: [] as HistoryUse[], omittedUses: candidate.omittedUses + candidate.uses.length };

    items.push(item);

    if (JSON.stringify(result).length > maxChars) {
      items.pop();
      continue;
    }

    for (const use of candidate.uses) {
      item.uses.push(use);
      item.omittedUses--;
      if (JSON.stringify(result).length > maxChars) {
        item.uses.pop();
        item.omittedUses++;
      }
    }
  }

  return structuredClone({ ...result, omittedVersions: eligible.length - items.length });
}
