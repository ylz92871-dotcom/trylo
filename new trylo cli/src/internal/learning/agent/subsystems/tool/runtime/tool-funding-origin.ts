import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { acquisitionInquiryOutcomeId, acquisitionInquirySpecId, decodeAcquisitionInquiryOutcome, decodeAcquisitionInquirySpec } from "../domain/evolution/acquisition-inquiry.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { recordOf } from "../domain/evolution/parse.js";
import { toolLearningJobId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolAcquisitionFailureFromBoard } from "./acquisition-failure-reader.js";
import { assetAvailable, pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import { planForJob } from "./pipeline-records.js";
import { readToolResearchLineage } from "../domain/evolution/research-lineage.js";

type Root = { readonly ok: true; readonly rootPlan: ToolLearningPlan; readonly rootJobId: string; readonly rootPlanHash: string };

/** Read-only proof, not permission or a funding decision. A materializer may
 * verify its exact review plan before enqueueing it; spend additionally needs
 * that plan's canonical running Board job in learning-funding. */
export function toolFundingOriginFromBoard(state: BoardState, plan: ToolLearningPlan): Root | PipelineFailure {
  return resolve(state, plan, new Set());
}

/** An investigation is a child of an already funded acquisition, never a new
 * focused-learning issue. Its current attempt has a frozen failure/spec. */
export function toolFundingInquiryFromBoard(state: BoardState, plan: ToolLearningPlan, jobId: string, attempt: number): Root | PipelineFailure {
  const asset = canonicalData(state, acquisitionInquirySpecId(jobId, attempt), plan.scope);
  const spec = asset === undefined ? undefined : decodeAcquisitionInquirySpec(asset.content);
  if (spec === undefined || spec.jobId !== jobId || spec.attempt !== attempt || spec.originalJobId !== toolLearningJobId(plan)
    || spec.scope !== plan.scope) return invalid();

  const root = toolFundingOriginFromBoard(state, plan);
  if (!root.ok) return root;

  const failure = toolAcquisitionFailureFromBoard(state, spec.failureRef, plan.scope);

  return failure.ok && failure.failure.jobId === spec.originalJobId && failure.failure.decisionVersionId === spec.approvalId
    && root.rootJobId === spec.rootJobId && root.rootPlanHash === spec.rootPlanHash ? root : invalid();
}

function resolve(state: BoardState, plan: ToolLearningPlan, seen: Set<string>): Root | PipelineFailure {
  if (plan.researchOrigin !== undefined) {
    const root = readToolResearchLineage(state, plan);
    return root === undefined ? invalid() : { ok: true, rootPlan: root.rootPlan, rootJobId: root.rootJobId, rootPlanHash: root.rootPlanHash };
  }

  const jobId = toolLearningJobId(plan), origin = plan.fundingOrigin;
  if (seen.has(jobId) || seen.size >= 16) return pipelineFailure("invalid_tool_funding_origin", "Acquisition funding lineage is cyclic or exceeds its bounded history");

  seen.add(jobId);

  if (origin === undefined) {
    const stored = planForJob(state, jobId);
    return stored !== undefined && contentHashOf(stored) === contentHashOf(plan)
      ? { ok: true, rootPlan: stored, rootJobId: jobId, rootPlanHash: contentHashOf(stored) }
      : pipelineFailure("invalid_tool_funding_origin", "The original learning plan has no canonical Board binding");
  }

  const outcomeAsset = canonicalData(state, origin.outcomeVersionId, plan.scope);
  const outcome = outcomeAsset === undefined ? undefined : decodeAcquisitionInquiryOutcome(outcomeAsset.content);
  const specId = acquisitionInquirySpecId(origin.inquiryJobId, origin.inquiryAttempt);
  const specAsset = canonicalData(state, specId, plan.scope);
  const spec = specAsset === undefined ? undefined : decodeAcquisitionInquirySpec(specAsset.content);
  const inquiry = state.jobs.find(row => row.jobId === origin.inquiryJobId);
  if (outcome === undefined || spec === undefined || inquiry?.domain !== "tool" || inquiry.scope !== plan.scope
    || inquiry.observationId !== spec.originalJobId || inquiry.attempt < spec.attempt
    || outcome.jobId !== origin.inquiryJobId || outcome.attempt !== origin.inquiryAttempt || outcome.scope !== plan.scope
    || origin.outcomeVersionId !== acquisitionInquiryOutcomeId(spec.jobId, spec.attempt) || outcome.specVersionId !== specId
    || spec.scope !== plan.scope || spec.jobId !== origin.inquiryJobId || spec.attempt !== origin.inquiryAttempt
    || spec.rootJobId !== origin.rootJobId || spec.rootPlanHash !== origin.rootPlanHash || outcome.status !== "proposed"
    || outcome.decision?.action !== "acquire" || outcome.search === undefined || outcome.review?.jobId !== jobId
    || contentHashOf(outcome.review.plan) !== contentHashOf(plan)) return invalid();

  const sourcePlan = planForJob(state, spec.originalJobId);
  if (sourcePlan === undefined || sourcePlan.scope !== plan.scope) return invalid();

  const root = resolve(state, sourcePlan, seen);
  if (!root.ok) return root;

  const failure = toolAcquisitionFailureFromBoard(state, spec.failureRef, plan.scope);
  if (!failure.ok || failure.failure.jobId !== spec.originalJobId || failure.failure.decisionVersionId !== spec.approvalId
    || root.rootJobId !== origin.rootJobId || root.rootPlanHash !== origin.rootPlanHash) return invalid();

  const decisionAsset = outcome.planningDecisionVersionId === undefined ? undefined : canonicalData(state, outcome.planningDecisionVersionId, plan.scope);
  if (decisionAsset === undefined || !recordOf(decisionAsset.content) || decisionAsset.content.type !== "tool_learning_decision"
    || decisionAsset.content.schemaVersion !== 1 || decisionAsset.content.jobId !== spec.jobId || decisionAsset.content.attempt !== spec.attempt
    || typeof decisionAsset.content.step !== "number" || !Number.isSafeInteger(decisionAsset.content.step) || decisionAsset.content.step < 1
    || contentHashOf(decisionAsset.content.decision) !== contentHashOf(outcome.decision)
    || outcome.planningDecisionVersionId !== toolLearningDecisionVersionId({ jobId: spec.jobId, attempt: spec.attempt,
      decision: outcome.decision, step: decisionAsset.content.step })
    || outcome.review.decisionVersionId !== toolLearningDecisionVersionId({ jobId, attempt: 1, decision: outcome.decision, step: 1 })) return invalid();

  const selected = outcome.decision.candidate;
  const chosen = outcome.search.candidates.some(row => row.platform === selected.platform && row.id === selected.id && row.version === selected.version);
  const evidenceRefs = [...new Set([...sourcePlan.trigger.evidenceRefs, spec.failureRef, outcome.planningDecisionVersionId!])];
  if (evidenceRefs.length > 64) return invalid();

  const expected: ToolLearningPlan = { ...sourcePlan, createdAt: plan.createdAt,
    trigger: { ...sourcePlan.trigger, proposalKey: `acquisition-review:${spec.jobId}:${spec.attempt}`,
      evidenceRefs }, fundingOrigin: origin };

  return chosen && contentHashOf(expected) === contentHashOf(plan) ? root : invalid();
}

function canonicalData(state: BoardState, versionId: string, scope: string) {
  const asset = state.assets.find(row => row.versionId === versionId);
  return asset !== undefined && asset.kind === "workflow" && asset.source === "inferred" && asset.scope === scope
    && assetAvailable(state, asset) ? asset : undefined;
}

function invalid(): PipelineFailure { return pipelineFailure("invalid_tool_funding_origin", "The review does not prove the exact original acquisition inquiry and lifetime grant"); }
