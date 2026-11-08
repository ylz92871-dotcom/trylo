import type { BoardState } from "../../../../control/state.js";
import type { GeneratedToolProductionPlan } from "../domain/evolution/production-plan.js";
import { applyToolContractRevisions } from "../domain/evolution/contract-revision.js";
import { approvedToolContractRevisionRecords } from "./contract-revision-reader.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** Rebuild from the original hidden checks and real Permission-backed records.
 * New hashes supplied by a candidate or contract cannot authorize an oracle. */
export function revisedPureProductionChecks(state: BoardState, versionId: string, parent: GeneratedToolProductionPlan, refs?: readonly string[]) {
  const approved = approvedToolContractRevisionRecords(state, versionId, parent.origin.scope, refs);
  if (!approved.ok) return approved;

  const revisionRefs = approved.revisions.map(row => row.revisionId).sort();
  const changed = applyToolContractRevisions({ parentVersionId: versionId, scope: parent.origin.scope,
    parentSamples: parent.checks.evidence, revisions: approved.revisions });
  if (!changed.ok) return changed;

  const checkRefs = [...new Set([...(parent.checks.contractRevisionRefs ?? []), ...revisionRefs])];
  if (checkRefs.length > 8) return pipelineFailure("contract_revision_capacity", "The inherited production contract exceeds eight exact correction references");

  const checks = revisionRefs.length === 0 ? parent.checks : { ...parent.checks, evidence: changed.effectiveSamples, contractRevisionRefs: checkRefs };

  return { ok: true as const, checks, revisionRefs, revisions: approved.revisions };
}
