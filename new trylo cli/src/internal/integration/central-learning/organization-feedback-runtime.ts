import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { OrganizationDecision, OrganizationFeedback, OrganizationProjection } from "../../learning/central/organization/contracts.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import type { CentralCompletedOperation } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimeCompletedIndex } from "../../learning/central/runtime/records.js";

const unique = (refs: readonly string[]) => [...new Set(refs)];
const originalReferences = (refs: readonly string[]) => unique(refs.filter(ref => !ref.startsWith("organization-")
  && !ref.startsWith("central-organization-") && !ref.startsWith("central-runtime-purpose-")));
const sourceValue = (feedback: OrganizationFeedback) => {
  const { supersedes: _revision, ...value } = feedback;
  return canonicalJson(value);
};

/** A paid computation's returned agenda is distinct from the expectation that
 * selected that operation earlier. Both retain the same original source unit. */
export const centralOrganizationDeliberationRef = (scope: string, operationId: string): string =>
  `central-organization-deliberation:${contentHashOf([scope, operationId])}`;
export const organizationDecisionForOperation = (scope: string, decision: OrganizationDecision | undefined, operationId: string): boolean =>
  decision !== undefined && (decision.decisionRef === operationId
    || decision.decisionRef === centralOrganizationDeliberationRef(scope, operationId)
      && decision.purposeRef === operationId && decision.sourceRefs.includes(operationId));

/** Shared by immediate publication and archival repair. A returned read, thought,
 * consultation or worker preparation is progress, never a quality assessment or
 * an additional business trial. The original operation remains the source unit. */
export function buildOrganizationRuntimeProgress(decisionRef: string, completed: CentralCompletedOperation, scope?: string): OrganizationFeedback {
  const operation = completed.operation;
  if (decisionRef !== operation.operationId && (scope === undefined
    || decisionRef !== centralOrganizationDeliberationRef(scope, operation.operationId))) throw new Error("organization_runtime_progress_decision_mismatch");

  const sources = unique([operation.operationId, ...originalReferences([...operation.sourceRefs, ...completed.resultRefs])]);
  const results = originalReferences(completed.resultRefs);
  const full = `public_progress_not_quality; ${completed.outcome}: ${completed.publicResult}`;
  const remaining = ["The retained learning intent determines remaining research; a work return alone does not answer its goal.",
    "This original runtime operation is public learning progress, not a new business sample or a quality verdict."];

  if (decisionRef !== operation.operationId) remaining.push("This computation decision and its earlier operation expectation refer to the same original operation unit, not separate executions or independent business samples.");

  let summary = full;

  if (full.length > 4096) {
    summary = `public_progress_not_quality; ${completed.outcome}; original publicResult is not reproduced because it exceeds organization capacity (${completed.publicResult.length} characters; original body hash ${contentHashOf(completed)}). Read the complete original completed operation with source.read using ${operation.operationId} before interpreting its result, conditions or exceptions.`;
  }

  if (sources.length > 64 || results.length > 64) {
    remaining.push(`Original references exceed organization capacity: ${Math.max(0, sources.length - 64)} source references and ${Math.max(0, results.length - 64)} result references are not reproduced (original body hash ${contentHashOf(completed)}). Read the complete original completed operation with source.read using ${operation.operationId}; no replacement reference set is created.`);
  }

  return { kind: "feedback", decisionRef, unitRef: operation.operationId, supersedes: null,
    sourceRefs: sources.slice(0, 64), result: { kind: "progress", summary, remaining, resultRefs: results.slice(0, 64) } };
}

/** Demand-directed repair from the original verified runtime history. Only an
 * already frozen expectation or canonical computation decision can receive progress.
 * Effective identical heads are skipped so repeated reads cannot create support. */
export function projectOrganizationRuntimeProgress(board: BoardState, view: OrganizationProjection,
  selection?: readonly string[]): readonly OrganizationFeedback[] {
  const requested = selection === undefined ? undefined : new Set(selection);
  const decisions = new Map(view.decisions.filter(row => requested === undefined || requested.has(row.value.decisionRef))
    .map(row => [row.value.decisionRef, row.value]));
  if (decisions.size === 0) return [];

  const heads = new Map(view.feedback.map(row => [organizationFeedbackKey(row.value), row]));
  const result: OrganizationFeedback[] = [];

  for (const row of readCentralRuntimeCompletedIndex(board.rewardV2Facts ?? [], view.scope, board.sequence)) {
    for (const decisionRef of [row.completed.operation.operationId, centralOrganizationDeliberationRef(view.scope, row.completed.operation.operationId)]) {
      if (!organizationDecisionForOperation(view.scope, decisions.get(decisionRef), row.completed.operation.operationId)) continue;
      const candidate = buildOrganizationRuntimeProgress(decisionRef, row.completed, view.scope);
      const previous = heads.get(organizationFeedbackKey(candidate));
      if (previous !== undefined && sourceValue(previous.value) === sourceValue(candidate)) continue;
      result.push({ ...candidate, supersedes: previous?.factId ?? null });
      if (result.length >= 8) return result;
    }
  }

  return result;
}
