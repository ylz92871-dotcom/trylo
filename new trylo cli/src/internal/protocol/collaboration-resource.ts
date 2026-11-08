import type { ExperienceBoundaryReceipt, ExperienceUseFeedback } from "./collaboration-experience.js";

/** Existing persisted resource-receipt bounds; action producers must fit the same contract before querying. */
export const COLLABORATION_RESOURCE_LIMITS = Object.freeze({ queryMaxChars: 1500, summaryMaxChars: 1500, maxResultRefs: 32, referenceMaxChars: 512 });

/** Observes a real resource call; it neither grants tools nor approves creation/retention. */
export type CollaborationResourceReceipt = {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly phase: "resource_query" | "resource_result";
  readonly scope: string;
  readonly issueId: string;
  readonly jobId: string;
  readonly grantId: string;
  readonly requestId: string;
  readonly owner: "tool" | "expert" | "experience" | "research";
  readonly query: string;
  readonly resultRefs: readonly string[];
  readonly summary: string;
  readonly status?: "available" | "empty" | "unavailable";
  readonly boundary: ExperienceBoundaryReceipt["boundary"];
  readonly recordedAt: string;
};

export type CollaborationRuntimeReceipt = ExperienceBoundaryReceipt | CollaborationResourceReceipt | ExperienceUseFeedback;
