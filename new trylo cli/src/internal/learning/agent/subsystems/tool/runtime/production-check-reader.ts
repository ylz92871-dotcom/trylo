import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { checkValidationRecord } from "../../../../verification-authority/validation-record.js";
import { keysAre, recordOf } from "../domain/evolution/parse.js";
import { decodeToolProductionCheckDiagnosis, toolProductionImplementationFailure, type ToolProductionFailureEvidence } from "../domain/evolution/production-check.js";
import { decodeToolProductionPlan, toolProductionScope } from "../domain/evolution/production-plan.js";
import { assetAvailable, pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import { productionFromBoard } from "./production-assets.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";

export type { ToolProductionFailureEvidence } from "../domain/evolution/production-check.js";

type Selection = { readonly versionId: string; readonly workspaceId: string; readonly jobId: string };

/** Reads completed checker diagnostics, not a receipt and never a fresh oracle.
 * Execution/environment failures remain blockers instead of code-change orders. */
export function toolProductionCheckFailureFromBoard(state: BoardState, input: Selection): PipelineFailure | {
  readonly ok: true; readonly reason: "implementation_mismatch" | "no_failed_check" | "unclassified" | "blocked" | "unsupported_parent";
  readonly evidence?: ToolProductionFailureEvidence; readonly parent?: { readonly versionId: string; readonly scope: string; readonly capability: string; readonly identity: string };
  readonly occurredAt?: string;
} {
  const selected = productionFromBoard(state, input.versionId, input.workspaceId);
  if (!selected.ok) return selected;

  const scope = toolProductionScope(selected.plan), prefix = `tool-production-check:v1:${contentHashOf(selected.plan)}:`;
  const job = state.jobs.find(item => item.jobId === input.jobId);
  if (job === undefined || !job.jobId.startsWith(prefix) || !/^[1-3]$/.test(job.jobId.slice(prefix.length))
    || job.domain !== "tool" || job.scope !== scope || job.observationId !== selected.proposalId || job.attempt !== 1 || job.maxAttempts !== 1) {
    return pipelineFailure("production_check_claim_lost", "diagnostic job is not the exact single-attempt production check");
  }

  if (job.state !== "failed") return { ok: true, reason: "no_failed_check" };

  const matches = state.assets.filter(asset => asset.kind === "workflow" && recordOf(asset.content)
    && asset.content.type === "tool_production_check_report" && asset.content.versionId === input.versionId && asset.content.jobId === input.jobId);
  if (matches.length !== 1) return pipelineFailure("production_check_report_missing", "a completed check needs one immutable report");

  const asset = matches[0]!, raw = asset.content;
  if (!recordOf(raw) || !keysAre(raw, ["type", "schemaVersion", "versionId", "jobId", "outcome", "record", "receiptId"], ["diagnosis"])
    || raw.schemaVersion !== 1 || raw.outcome !== "failed" || raw.receiptId !== null || !assetAvailable(state, asset)
    || asset.source !== "user_explicit" || asset.scope !== scope || asset.versionId !== `production-check-report:${contentHashOf(raw)}`) {
    return pipelineFailure("invalid_production_check_report", "failure report failed exact immutable lifecycle or outcome checks");
  }

  // This helper checks shape/derived consistency only. It does not issue authority.
  const checked = checkValidationRecord(raw.record);
  if (!checked.ok || checked.record.verdict !== "fail" || checked.record.packageVersionId !== input.versionId) {
    return { ok: true, reason: "unclassified" };
  }

  if (raw.diagnosis === undefined) return { ok: true, reason: "unclassified" };

  const diagnosis = decodeToolProductionCheckDiagnosis(raw.diagnosis, selected.plan, checked.record);
  if (diagnosis === undefined || checked.record.validationId !== `validation:${input.versionId}:${contentHashOf(checked.record.stages)}`) {
    return pipelineFailure("production_diagnosis_mismatch", "diagnosis does not identify this actual frozen checker result");
  }

  if (!toolProductionImplementationFailure(diagnosis)) return { ok: true, reason: "blocked" };

  const parent = toolLearningParentFromBoard(state, input.versionId);
  if (!parent.ok) return { ok: true, reason: "unsupported_parent" };

  return { ok: true, reason: "implementation_mismatch", parent: parent.parent, occurredAt: asset.createdAt,
    evidence: { reportVersionId: asset.versionId, productionVersionId: input.versionId, checkJobId: input.jobId,
      parentVersionId: parent.parent.versionId, checksHash: diagnosis.checksHash, stage: diagnosis.stage,
      caseSet: diagnosis.caseSet, executionKind: diagnosis.executionKind } };
}

/** Safe summaries only. Never copy report details, hidden case IDs or the fresh
 * checks into requirements/grounded samples or source-generation prompts. */
export function toolLearningProductionFailures(state: BoardState, plan: ToolLearningPlan): PipelineFailure | {
  readonly ok: true; readonly failures: readonly ToolProductionFailureEvidence[];
} {
  if (plan.targetVersionId === undefined) return { ok: true, failures: [] };

  const failures: ToolProductionFailureEvidence[] = [];
  const explicit = new Set(plan.trigger.evidenceRefs);
  const reports = state.assets.filter(asset => asset.kind === "workflow" && recordOf(asset.content) && asset.content.type === "tool_production_check_report");
  if (reports.length > 768) return pipelineFailure("production_check_history_limit", "production check recovery requires bounded archive maintenance");

  for (const asset of [...reports].reverse().sort((left, right) => Number(explicit.has(right.versionId)) - Number(explicit.has(left.versionId)))) {
    if (!recordOf(asset.content) || typeof asset.content.versionId !== "string" || typeof asset.content.jobId !== "string") continue;

    const raw = asset.content;
    const production = state.assets.find(item => item.versionId === raw.versionId);
    if (!recordOf(production?.content) || typeof production.content.workspaceId !== "string") continue;

    // Select coordinates before following immutable lineage. Otherwise reading
    // an old pure parent can recursively validate an unrelated npm descendant's
    // own check report while that descendant is already proving its parent.
    const decoded = decodeToolProductionPlan(production.content);
    if (decoded !== undefined) {
      const parentVersionId = decoded.type === "tool_production_package" ? decoded.origin.versionId : production.versionId;
      if (parentVersionId !== plan.targetVersionId || decoded.origin.scope !== plan.scope) {
        if (explicit.has(asset.versionId)) return pipelineFailure("production_failure_parent_mismatch", "The explicit check report belongs to another exact learning parent");
        continue;
      }
    }

    const selected = toolProductionCheckFailureFromBoard(state, { versionId: asset.content.versionId, jobId: asset.content.jobId, workspaceId: production.content.workspaceId });
    if (!selected.ok) {
      if (explicit.has(asset.versionId)) return selected;
      continue;
    }

    if (selected.evidence?.parentVersionId !== plan.targetVersionId || selected.parent?.scope !== plan.scope) continue;

    failures.push(selected.evidence);

    if (failures.length >= 8) break;
  }

  return { ok: true, failures };
}

export function toolProductionFailureFeedback(failures: readonly ToolProductionFailureEvidence[]): string {
  return failures.length === 0 ? "" : [
    "Independent production checks found a returned value/tool_error inconsistent with their already frozen contract. This is an implementation investigation, not permission or a new expected result.",
    ...failures.map(failure => `production=${failure.productionVersionId}; report=${failure.reportVersionId}; stage=${failure.stage}; cases=${failure.caseSet}; returned=${failure.executionKind}; frozenChecks=${failure.checksHash}`),
    "This diagnostic withholds case identities, inputs and expected values. Previously disclosed parent cases are regressions. Infer a general repair from the existing contract and independent requirements, preserve its oracle, and defer when they cannot justify a repair. Do not guess or rewrite undisclosed expected values. No production recheck or activation is authorized.",
  ].join("\n");
}
