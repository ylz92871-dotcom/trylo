import { keysAre, recordOf } from "./parse.js";

/** A host-materialized review lineage claim; Board proof is mandatory before any spend. */
export type ToolLearningFundingOrigin = { readonly rootJobId: string; readonly rootPlanHash: string; readonly inquiryJobId: string;
  readonly inquiryAttempt: number; readonly outcomeVersionId: string };

export function decodeToolLearningFundingOrigin(raw: unknown): ToolLearningFundingOrigin | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["rootJobId", "rootPlanHash", "inquiryJobId", "inquiryAttempt", "outcomeVersionId"])
    || typeof raw.rootJobId !== "string" || !/^tool-learning_v1_[a-f0-9]{64}$/.test(raw.rootJobId)
    || typeof raw.rootPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.rootPlanHash)
    || typeof raw.inquiryJobId !== "string" || !/^tool-acquisition-inquiry_v1_[a-f0-9]{64}$/.test(raw.inquiryJobId)
    || typeof raw.inquiryAttempt !== "number" || !Number.isSafeInteger(raw.inquiryAttempt) || raw.inquiryAttempt < 1 || raw.inquiryAttempt > 3
    || raw.outcomeVersionId !== `acquisition-inquiry-result:${raw.inquiryJobId}:${raw.inquiryAttempt}`) return undefined;
  return { rootJobId: raw.rootJobId, rootPlanHash: raw.rootPlanHash, inquiryJobId: raw.inquiryJobId, inquiryAttempt: raw.inquiryAttempt, outcomeVersionId: raw.outcomeVersionId };
}
