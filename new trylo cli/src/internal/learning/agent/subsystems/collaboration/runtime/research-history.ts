import type { CollaborationResourceReceipt } from "../../../../../protocol/collaboration-resource.js";
import { COLLABORATION_RESOURCE_LIMITS } from "../../../../../protocol/collaboration-resource.js";
import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { collaborationResourceResultMatches } from "../../../../control/collaboration-resource-relation.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import type { ExperienceResult } from "../experience/contracts.js";
import type { CollaborationResearchRecoveryPort } from "../orchestration/contracts.js";

const DEFAULT_MAX_CHARS = 4000, MIN_MAX_CHARS = 512, MAX_MAX_CHARS = 16000;

type RecoveryInput = Parameters<CollaborationResearchRecoveryPort>[0];

type RecoveryContent = { readonly observations: readonly unknown[]; readonly sourceRefs: readonly string[] };

type ResourceItem = {
  readonly queryReceiptId: string; readonly resultReceiptId: string; readonly requestId: string;
  readonly owner: CollaborationResourceReceipt["owner"]; readonly query: string;
  readonly recordedAt: string; readonly status: NonNullable<CollaborationResourceReceipt["status"]> | "not_recorded";
  readonly summary: string; readonly mayBeTruncated: boolean; readonly resultRefs: readonly string[];
};

type History = {
  readonly schema: "collaboration-research-history/v1";
  readonly content: "summary_only"; readonly sourceBodies: "not_recovered"; readonly currentAvailability: "not_checked";
  readonly note: string;
  readonly items: readonly ResourceItem[]; readonly omittedItemCount: number;
  readonly unpairedQueryCount: number; readonly unpairedResultCount: number;
};

function projection(items: readonly ResourceItem[], count: number, queries: number, results: number): History {
  return { schema: "collaboration-research-history/v1", content: "summary_only", sourceBodies: "not_recovered",
    currentAvailability: "not_checked", note: "Historical previews only; completeness was not recorded. A 1500-character preview may be truncated. Missing pairs restore no references. This is not an exactly-once cache or current capability admission.",
    items, omittedItemCount: count - items.length, unpairedQueryCount: queries, unpairedResultCount: results };
}

/** Canonical same-grant facts only. An item and all of its exact references enter the budget together. */
export function recoverCollaborationResearch(state: BoardState, input: RecoveryInput & {
  readonly scope: string; readonly maxChars?: number;
}): ExperienceResult<RecoveryContent> {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS, current = coordinationForJob(state, input.jobId);
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) {
    return { ok: false, reason: "learning_research_preview_limit_invalid" };
  }

  if (current === undefined || current.grant.grantId !== input.grantId || current.issue.issueId !== input.issueId
    || current.issue.scope !== input.scope || current.grant.scope !== input.scope || current.job.scope !== input.scope) {
    return { ok: false, reason: "learning_research_grant_mismatch" };
  }

  const receipts = (state.collaborationRuntimeReceipts ?? []).filter((receipt): receipt is CollaborationResourceReceipt =>
    (receipt.phase === "resource_query" || receipt.phase === "resource_result") && receipt.scope === input.scope
    && receipt.issueId === input.issueId && receipt.jobId === input.jobId && receipt.grantId === input.grantId);
  const queries = receipts.filter(receipt => receipt.phase === "resource_query"), results = receipts.filter(receipt => receipt.phase === "resource_result");
  const paired = results.flatMap(result => {
    const query = queries.find(item => collaborationResourceResultMatches(item, result));
    return query === undefined ? [] : [{ query, result }];
  });
  const unpairedQueries = queries.filter(query => !paired.some(pair => pair.query.receiptId === query.receiptId)).length;
  const unpairedResults = results.length - paired.length;

  if (receipts.length === 0) return { ok: true, observations: [], sourceRefs: [] };

  let items: ResourceItem[] = [], sourceRefs: string[] = [];
  const content = (): RecoveryContent => ({ observations: [projection(items, paired.length, unpairedQueries, unpairedResults)], sourceRefs });
  if (JSON.stringify(content()).length > maxChars) return { ok: false, reason: "learning_research_preview_limit_invalid" };

  for (const { query, result } of paired.slice().reverse()) {
    const item: ResourceItem = { queryReceiptId: query.receiptId, resultReceiptId: result.receiptId, requestId: result.requestId,
      owner: result.owner, query: result.query, recordedAt: result.recordedAt, status: result.status ?? "not_recorded",
      summary: result.summary, mayBeTruncated: result.summary.length >= COLLABORATION_RESOURCE_LIMITS.summaryMaxChars, resultRefs: [...result.resultRefs] };
    const nextItems = [...items, item], nextRefs = [...new Set([...sourceRefs, result.receiptId, ...result.resultRefs])];
    const candidate = { observations: [projection(nextItems, paired.length, unpairedQueries, unpairedResults)], sourceRefs: nextRefs };
    if (JSON.stringify(candidate).length <= maxChars) {
      items = nextItems;
      sourceRefs = nextRefs;
    }
  }

  return { ok: true, ...content() };
}

/** A read adapter over the existing Board. It neither queries external resources nor writes recovery state. */
export function createCollaborationResearchRecovery(options: {
  readonly board: Pick<BoardStore, "load">; readonly scope: string; readonly enabled?: () => boolean; readonly maxChars?: number;
}): CollaborationResearchRecoveryPort {
  return async input => {
    if (options.enabled?.() === false) return { ok: false, reason: "collect_disabled" };
    try {
      const loaded = await options.board.load();
      if (!loaded.ok) return { ok: false, reason: loaded.reason };
      if (options.enabled?.() === false) return { ok: false, reason: "collect_disabled" };
      return recoverCollaborationResearch(loaded.state, { ...input, scope: options.scope,
        ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }) });
    } catch { return { ok: false, reason: "learning_research_recovery_unavailable" }; }
  };
}
