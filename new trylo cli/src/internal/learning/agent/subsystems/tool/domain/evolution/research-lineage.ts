import type { BoardState } from "../../../../../control/state.js";
import type { LearningIssue } from "../../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { assetAvailable } from "./asset-availability.js";
import { toolLearningDecisionVersionId } from "./decision-identity.js";
import { toolLearningFundingClaimBelongsTo, toolLearningFundingIdentity } from "./funding-identity.js";
import { decodeToolLearningPlan, decodeToolLearningResult, planVersionId, resultVersionId, toolLearningJobId, type ToolLearningPlan } from "./pipeline.js";
import { recordOf } from "./parse.js";
import { decodeToolResearchSupplement, toolResearchSupplementId, type ToolResearchSupplement } from "./research-origin.js";
import type { ToolEvolutionRequirement } from "./contracts.js";

type Lineage = { readonly rootPlan: ToolLearningPlan; readonly rootJobId: string; readonly rootPlanHash: string;
  readonly plans: readonly ToolLearningPlan[]; readonly supplements: readonly ToolResearchSupplement[] };

/** Reconstruct the exact host-written predecessor chain; a rootJobId string is
 * never sufficient to select another task's existing purse. */
export function readToolResearchLineage(state: BoardState, plan: ToolLearningPlan): Lineage | undefined {
  return read(state, plan, new Set());
}

/** Planning and construction use the same canonical public materials, including
 * when a committed recipe resumes without another planning request. */
export function toolResearchRequirements(state: BoardState, plan: ToolLearningPlan): readonly ToolEvolutionRequirement[] | undefined {
  if (plan.researchOrigin === undefined) return [];
  return readToolResearchLineage(state, plan)?.supplements.flatMap(row => row.materials.map(material => ({
    ref: material.ref, kind: "external_contract" as const,
    text: `Host-supplied controlled task contract; not original user wording, observed output, approval or benefit. contentHash=${material.contentHash}.\n${material.text}` })));
}

function read(state: BoardState, plan: ToolLearningPlan, visited: Set<string>): Lineage | undefined {
  const id = toolLearningJobId(plan);
  if (visited.has(id) || plan.fundingOrigin !== undefined) return undefined;

  visited.add(id);
  const canonical = toolLearningPlanFromBoard(state, id);

  // The original enqueue owner previews a deterministic new leaf before its
  // plan commit. Every predecessor and the supplement must already be stored.
  if (canonical === undefined ? plan.researchOrigin === undefined : contentHashOf(canonical) !== contentHashOf(plan)) return undefined;

  const origin = plan.researchOrigin;
  if (origin === undefined) return { rootPlan: plan, rootJobId: id, rootPlanHash: contentHashOf(plan), plans: [plan], supplements: [] };

  const supplementAsset = data(state, origin.supplementVersionId, plan.scope);
  const supplement = supplementAsset === undefined ? undefined : decodeToolResearchSupplement(supplementAsset.content);
  const previous = toolLearningPlanFromBoard(state, origin.previousJobId);
  if (supplement === undefined || previous === undefined || supplement.scope !== plan.scope
    || supplement.previousJobId !== origin.previousJobId || supplement.previousResultRef !== origin.previousResultRef
    || toolResearchSupplementId(supplement) !== origin.supplementVersionId) return undefined;

  const ancestor = read(state, previous, visited);
  if (ancestor === undefined || ancestor.rootJobId !== origin.rootJobId || ancestor.rootPlanHash !== origin.rootPlanHash
    || !unqualifiedPredecessor(state, previous, origin.previousResultRef)) return undefined;

  const known = new Set(ancestor.supplements.flatMap(row => row.materials.map(material => material.contentHash)));
  if (!supplement.materials.some(material => !known.has(material.contentHash))) return undefined;

  const expected = toolResearchSuccessorPlan(previous, ancestor, supplement);

  return contentHashOf(expected) === contentHashOf(plan) ? { ...ancestor, plans: [...ancestor.plans, plan],
    supplements: [...ancestor.supplements, supplement] } : undefined;
}

/** A negative delivery remains negative. A successor needs new material rather
 * than reopening a completed attempt or interpreting queued funds as work. */
export function unqualifiedPredecessor(state: BoardState, plan: ToolLearningPlan, ref: string): boolean {
  const id = toolLearningJobId(plan), job = state.jobs.find(row => row.jobId === id);
  if (job?.domain !== "tool" || job.scope !== plan.scope || job.state !== "succeeded" || job.breakerOpen
    || ref !== resultVersionId(id, job.attempt)) return false;

  const archived = data(state, ref, plan.scope), result = archived === undefined ? undefined : decodeToolLearningResult(archived.content);
  if (result?.jobId !== id || result.attempt !== job.attempt || result.outcome !== "succeeded" || result.cleanupCode !== undefined
    || result.candidateVersionId !== undefined || result.contractProposalId !== undefined || result.generation !== undefined
    || result.decisionVersionId === undefined || result.decision === undefined) return false;

  const receipt = data(state, result.decisionVersionId, plan.scope)?.content;
  if (!recordOf(receipt) || receipt.type !== "tool_learning_decision" || receipt.jobId !== id || receipt.attempt !== job.attempt
    || receipt.grantId !== toolLearningFundingIdentity(plan).grantId || contentHashOf(receipt.decision) !== contentHashOf(result.decision)
    || typeof receipt.step !== "number" || result.decisionVersionId !== toolLearningDecisionVersionId({ jobId: id,
      attempt: job.attempt, step: receipt.step, decision: result.decision })) return false;

  const noProposal = result.decision.action === "reuse" && receipt.selectedToolVersionId === undefined
    && result.code === "existing_capability_reused" || result.decision.action === "defer" && result.decision.reason === "not_worthwhile"
    && result.code === "not_worthwhile";
  if (!noProposal) return false;

  const grant = state.centralLearningGrants?.find(row => row.grantId === toolLearningFundingIdentity(plan).grantId);
  const owned = (claimId: string) => toolLearningFundingClaimBelongsTo(plan, id, job.attempt, claimId);
  const reservations = grant?.reservations.filter(row => owned(row.claimId)) ?? [];

  return grant?.domain === "tool" && reservations.length > 0
    && reservations.every(row => row.state === "settled" && row.usage?.kind === "reported")
    && (grant.claim === undefined || !owned(grant.claim.claimId));
}

export function toolResearchSuccessorPlan(previous: ToolLearningPlan, root: Pick<Lineage, "rootJobId" | "rootPlanHash">,
  supplement: ToolResearchSupplement): ToolLearningPlan {
  const supplementVersionId = toolResearchSupplementId(supplement);
  return { ...previous, createdAt: supplement.createdAt, trigger: { ...previous.trigger,
    action: "research_successor", proposalKey: supplementVersionId,
    evidenceRefs: [...new Set([...previous.trigger.evidenceRefs, supplement.previousResultRef, supplementVersionId])] },
    researchOrigin: { rootJobId: root.rootJobId, rootPlanHash: root.rootPlanHash, previousJobId: supplement.previousJobId,
      previousResultRef: supplement.previousResultRef, supplementVersionId } };
}

/** Pure canonical plan archive reader. Runtime namespace validation remains
 * with planForJob; lineage/history must not recursively call that guard. */
export function toolLearningPlanFromBoard(state: BoardState, id: string) {
  const raw = state.assets.find(row => row.versionId === planVersionId(id));
  const plan = raw?.kind === "workflow" && assetAvailable(state, raw) ? decodeToolLearningPlan(raw.content) : undefined;
  return plan !== undefined && raw?.scope === plan.scope && toolLearningJobId(plan) === id ? plan : undefined;
}

/** Reports may point both backward and forward along one exact research root.
 * A later episode cannot invalidate historical readability of its predecessor. */
export function toolResearchReportsMatchRoot(state: BoardState, reports: LearningIssue["reports"], plan: ToolLearningPlan): boolean {
  const root = readToolResearchLineage(state, plan), jobId = toolLearningJobId(plan);
  return root !== undefined && reports.some(report => "subsystem" in report.source && report.source.subsystem === "tool" && report.source.versionId === jobId)
    && reports.every(report => {
      if (!("subsystem" in report.source) || report.source.subsystem !== "tool" || report.source.taskId !== plan.trigger.runId) return false;
      const reportedPlan = toolLearningPlanFromBoard(state, report.source.versionId);
      const reported = reportedPlan === undefined ? undefined : readToolResearchLineage(state, reportedPlan);
      return reported !== undefined && reported.rootJobId === root.rootJobId && reported.rootPlanHash === root.rootPlanHash;
    });
}

function data(state: BoardState, id: string, scope: string) {
  const asset = state.assets.find(row => row.versionId === id);
  return asset?.kind === "workflow" && asset.scope === scope && assetAvailable(state, asset) ? asset : undefined;
}
