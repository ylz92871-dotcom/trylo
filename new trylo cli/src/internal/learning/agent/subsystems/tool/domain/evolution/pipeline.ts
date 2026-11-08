import { decodeDiscoverySummary, type ToolDiscoverySummary } from "./discovery.js";

export { decodeDiscoverySummary, type ToolDiscoverySummary } from "./discovery.js";

import { contentHashOf } from "../../../../../control/hash.js";
import { hasManagedToolPipelineHistory, isToolPipelineCounter } from "./pipeline-lifetime.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf, parseToolEvolutionRequest } from "./parse.js";
import type { ToolEvolutionRequest } from "./contracts.js";
import type { BoardState } from "../../../../../control/state.js";
import { JOB_STATES } from "../../../../../control/contracts.js";
import { decodeToolEvolutionVerification } from "./artifact.js";
import type { ToolEvolutionVerification } from "./verification.js";
import { decodeToolLearningDecision, type ToolLearningDecision } from "./learning-plan.js";
import { decodeToolOpportunityEvidence, type ToolOpportunityEvidence } from "../awareness/opportunity.js";
import { toolContractProposalId } from "./contract-revision.js";
import { isToolLearningCleanupCode, type ToolLearningCleanupCode } from "./cleanup.js";
import { decodeToolLearningFundingOrigin, type ToolLearningFundingOrigin } from "./funding-origin.js";
import { decodeToolResearchOrigin, type ToolResearchOrigin } from "./research-origin.js";

export const TOOL_JOB_PREFIX = "tool-learning_v1_";
const TOOL_JOB_ID = new RegExp(`^${TOOL_JOB_PREFIX}[a-f0-9]{64}$`);
export const MAX_TOOL_PIPELINE_JOBS = 1_024;

export type ToolLearningPlan = {
  readonly type: "tool_learning_plan";
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly capability: string;
  readonly trigger: { readonly runId: string; readonly proposalKey: string; readonly evidenceRefs: readonly string[]; readonly action: string; readonly tool?: string };
  readonly createdAt: string;
  readonly opportunity?: ToolOpportunityEvidence;
  readonly targetVersionId?: string;
  readonly fundingOrigin?: ToolLearningFundingOrigin;
  readonly researchOrigin?: ToolResearchOrigin;
};

export type ToolLearningRecipe = {
  readonly type: "tool_learning_recipe";
  readonly schemaVersion: 1;
  readonly automation: "manual" | "after_turn";
  readonly request: ToolEvolutionRequest;
};

export type ToolLearningResult = {
  readonly type: "tool_learning_result";
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly attempt: number;
  readonly outcome: "waiting_evidence" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
  readonly code: string;
  readonly search: ToolDiscoverySummary;
  readonly recipeVersionId?: string;
  readonly candidateVersionId?: string;
  readonly occurredAt: string;
  readonly generation?: ToolGenerationTrace;
  readonly decision?: ToolLearningDecision;
  readonly decisionVersionId?: string;
  readonly inputFingerprint?: string;
  readonly inputFingerprintPolicy?: 2;
  readonly previousCode?: string;
  readonly cleanupCode?: ToolLearningCleanupCode;
  readonly contractProposalId?: string;
};

export type ToolGenerationTrace = { readonly attempts: number; readonly rejectionCode?: string; readonly verification?: ToolEvolutionVerification };

/** Legacy cleanup wrappers preserve the actual learning decision separately. */
export function toolLearningOutcomeCode(result: Pick<ToolLearningResult, "code" | "previousCode">): string { return result.previousCode ?? result.code; }

export function toolLearningJobId(plan: ToolLearningPlan): string {
  return `${TOOL_JOB_PREFIX}${contentHashOf(plan)}`;
}

export function planVersionId(jobId: string): string { return `plan:${jobId}`; }

export function resultVersionId(jobId: string, attempt: number): string { return `result:${jobId}:${attempt}`; }

export function isToolLearningJobId(value: unknown): value is string { return typeof value === "string" && TOOL_JOB_ID.test(value); }

/** Old Board snapshots predate job payload guards; protect this executable namespace at reads. */
export function validToolPipelineJobs(state: BoardState): boolean {
  return Array.isArray(state.jobs) && state.jobs.every(job => recordOf(job) && textOf(job.jobId)
    && (!job.jobId.startsWith(TOOL_JOB_PREFIX) || (isToolLearningJobId(job.jobId)
      && job.domain === "tool" && textOf(job.scope, 512) && textOf(job.observationId, 512) && textOf(job.dedupeKey, 1_400)
      && JOB_STATES.some(value => value === job.state) && isToolPipelineCounter(job.attempt, 0)
      && (job.attempt <= 3 || hasManagedToolPipelineHistory(state, job.jobId))
      && job.maxAttempts === 3 && typeof job.breakerOpen === "boolean")));
}

export function decodeToolLearningPlan(raw: unknown): ToolLearningPlan | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 196_608 || !recordOf(raw) || !recordOf(raw.trigger)) return undefined;

  const value = raw, trigger = raw.trigger;
  if (!keysAre(value, ["type", "schemaVersion", "scope", "capability", "trigger", "createdAt"], ["opportunity", "targetVersionId", "fundingOrigin", "researchOrigin"])
    || value.type !== "tool_learning_plan" || value.schemaVersion !== 1 || !bounded(value.scope, 512) || !bounded(value.capability, 512)
    || !bounded(value.createdAt, 64) || !keysAre(trigger, ["runId", "proposalKey", "evidenceRefs", "action"], ["tool"])
    || !bounded(trigger.runId, 160) || !bounded(trigger.proposalKey, 512) || !bounded(trigger.action, 120)
    || (trigger.tool !== undefined && !bounded(trigger.tool, 512)) || (value.targetVersionId !== undefined && !bounded(value.targetVersionId, 160))
    || !Array.isArray(trigger.evidenceRefs) || trigger.evidenceRefs.length > 64 || !trigger.evidenceRefs.every(ref => bounded(ref, 512))) return undefined;

  const opportunity = value.opportunity === undefined ? undefined : decodeToolOpportunityEvidence(value.opportunity);
  if (value.opportunity !== undefined && opportunity === undefined) return undefined;

  const fundingOrigin = value.fundingOrigin === undefined ? undefined : decodeToolLearningFundingOrigin(value.fundingOrigin);
  if (value.fundingOrigin !== undefined && fundingOrigin === undefined) return undefined;

  const researchOrigin = value.researchOrigin === undefined ? undefined : decodeToolResearchOrigin(value.researchOrigin);
  if (value.researchOrigin !== undefined && (researchOrigin === undefined || fundingOrigin !== undefined)) return undefined;

  if (opportunity?.task !== undefined && opportunity.task.turnId !== trigger.runId) return undefined;

  return { type: "tool_learning_plan", schemaVersion: 1, scope: value.scope, capability: value.capability,
    ...(opportunity === undefined ? {} : { opportunity }),
    ...(fundingOrigin === undefined ? {} : { fundingOrigin }),
    ...(researchOrigin === undefined ? {} : { researchOrigin }),
    ...(value.targetVersionId === undefined ? {} : { targetVersionId: value.targetVersionId }),
    createdAt: value.createdAt, trigger: { runId: trigger.runId, proposalKey: trigger.proposalKey, action: trigger.action, evidenceRefs: [...trigger.evidenceRefs],
      ...(trigger.tool === undefined ? {} : { tool: trigger.tool }) } };
}

export function decodeToolLearningRecipe(raw: unknown): ToolLearningRecipe | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 262_144 || !recordOf(raw)) return undefined;

  const value = raw;
  if (!keysAre(value, ["type", "schemaVersion", "automation", "request"]) || value.type !== "tool_learning_recipe"
    || value.schemaVersion !== 1 || (value.automation !== "manual" && value.automation !== "after_turn")) return undefined;

  const request = parseToolEvolutionRequest(value.request);
  if (!request.ok || (request.value.operation === "create" && request.value.prior !== undefined)) return undefined;

  return { type: "tool_learning_recipe", schemaVersion: 1, automation: value.automation, request: request.value };
}

export function decodeToolLearningResult(raw: unknown): ToolLearningResult | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 393_216 || !recordOf(raw)) return undefined;

  const value = raw;
  if (!keysAre(value, ["type", "schemaVersion", "jobId", "attempt", "outcome", "code", "search", "occurredAt"], ["recipeVersionId", "candidateVersionId", "generation", "decision", "decisionVersionId", "inputFingerprint", "inputFingerprintPolicy", "previousCode", "contractProposalId", "cleanupCode"])
    || value.type !== "tool_learning_result" || value.schemaVersion !== 1 || !bounded(value.jobId, 160) || !Number.isSafeInteger(value.attempt)
    || !isToolPipelineCounter(value.attempt) || !bounded(value.code, 160) || !bounded(value.occurredAt, 64)
    || !["waiting_evidence", "waiting_approval", "succeeded", "failed", "cancelled"].includes(String(value.outcome))
    || (value.recipeVersionId !== undefined && !bounded(value.recipeVersionId, 160))
    || (value.candidateVersionId !== undefined && !bounded(value.candidateVersionId, 160))
    || (value.decisionVersionId !== undefined && !bounded(value.decisionVersionId, 160))
    || (value.contractProposalId !== undefined && !bounded(value.contractProposalId, 160))
    || (value.inputFingerprint !== undefined && (typeof value.inputFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)))
    || (value.inputFingerprintPolicy !== undefined && (value.inputFingerprintPolicy !== 2 || value.inputFingerprint === undefined))
    || (value.previousCode !== undefined && (!bounded(value.previousCode, 160) || value.code !== "allowance_release_failed"))
    || (value.cleanupCode !== undefined && (!isToolLearningCleanupCode(value.cleanupCode) || value.code !== "allowance_release_failed"))
    || ((value.decision !== undefined) !== (value.decisionVersionId !== undefined))
    || (value.decision !== undefined && decodeToolLearningDecision(value.decision) === undefined)) return undefined;

  const search = decodeDiscoverySummary(value.search);
  const decision = value.decision === undefined ? undefined : decodeToolLearningDecision(value.decision);
  const effectiveCode = value.previousCode ?? value.code;
  if (search === undefined || (value.generation !== undefined && decodeToolGenerationTrace(value.generation) === undefined)
    || ((value.code === "contract_revision_approval_required" || value.previousCode === "contract_revision_approval_required")
      && (value.contractProposalId === undefined || value.outcome !== "waiting_evidence"))
    || (value.contractProposalId !== undefined && (decision?.action !== "revise_contract"
      || value.contractProposalId !== toolContractProposalId(decision.proposal)))
    || (effectiveCode === "acquisition_approval_required" && decision?.action !== "acquire")
    || (effectiveCode === "npm_candidate_pending_review" && (decision?.action !== "adapt" || value.candidateVersionId === undefined))
    || (value.outcome === "waiting_approval" && decision?.action !== "acquire" && effectiveCode !== "npm_candidate_pending_review"
      && (value.candidateVersionId === undefined || value.recipeVersionId === undefined))) return undefined;

  // Shape and size are checked above; rebuild through JSON to detach persistence input.
  return JSON.parse(JSON.stringify({ ...value, search })) as ToolLearningResult;
}

export function decodeToolGenerationTrace(raw: unknown): ToolGenerationTrace | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > 49_152 || !keysAre(raw, ["attempts"], ["rejectionCode", "verification"])
    || typeof raw.attempts !== "number" || !Number.isSafeInteger(raw.attempts) || raw.attempts < 0 || raw.attempts > 3
    || (raw.rejectionCode !== undefined && (typeof raw.rejectionCode !== "string" || !/^[a-z][a-z0-9_]{0,159}$/.test(raw.rejectionCode)))) return undefined;

  const verification = raw.verification === undefined ? undefined : decodeToolEvolutionVerification(raw.verification);
  if (raw.verification !== undefined && verification === undefined) return undefined;

  return { attempts: raw.attempts, ...(raw.rejectionCode === undefined ? {} : { rejectionCode: raw.rejectionCode }),
    ...(verification === undefined ? {} : { verification }) };
}


function bounded(value: unknown, length: number): value is string { return textOf(value, length); }
