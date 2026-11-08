import type { CentralFundedStage } from "../../../../../integration/central-learning/contracts.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { planVersionId, resultVersionId, type ToolLearningPlan, type ToolLearningResult } from "../domain/evolution/pipeline.js";
import { recordOf } from "../domain/evolution/parse.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { selectToolFocusedSource, toolCentralSourceBinding, toolCentralStageAttempt } from "./central-source.js";
import { candidateBindsToolLearningRecipe, planForJob, resultForJob } from "./pipeline-records.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";
import { candidateIdentityFromBoard } from "./evolution-reader.js";
import { productionIdentityFromBoard } from "./production-assets.js";

/** Historical publication proof at a previously verified central input. This
 * grants no execution authority and never selects arbitrary completed refs. */
export function readCentralToolStageProduction(board: BoardState, options: {
  readonly scope: string; readonly workspaceId?: string; readonly input: CentralFundedStage;
}): { readonly outputs: readonly string[]; readonly sourceRefs: readonly string[] } {
  const { input } = options, refs = new Set<string>(), outputs = new Set<string>();
  const done = () => ({ outputs: [...outputs].sort(), sourceRefs: [...refs].sort() });
  const stage = toolCentralStageAttempt(input.stageRef);
  if (stage === undefined || input.offer.owner.plane !== "agent" || input.offer.owner.domain !== "tool"
    || input.offer.policyRef !== input.policyRef
    || input.sourceBindingRef !== toolCentralSourceBinding(stage.jobId, input.stageRef, input.policyRef)) return done();

  const plan = planForJob(board, stage.jobId), issue = board.learningIssues?.find(row => row.issueId === input.issueId);
  if (plan === undefined || options.workspaceId !== undefined && options.workspaceId !== plan.scope) return done();

  const source = selectToolFocusedSource(board, issue, plan.scope, options.scope);
  const grant = board.centralLearningGrants?.find(row => row.grantId === input.grantId);
  if (!source.ok || issue === undefined || source.jobId !== stage.jobId || source.grantId !== input.grantId
    || grant === undefined || !toolFundingGrantMatches(board, plan, grant) || grant.scope !== options.scope
    || input.expectedIssueRevision < grant.focusRevision || input.expectedIssueRevision > issue.revision
    || source.job.attempt < stage.attempt) return done();

  for (const ref of [input.issueId, input.grantId, input.stageRef, input.sourceBindingRef, planVersionId(stage.jobId)]) refs.add(ref);

  const result = resultForJob(board, stage.jobId, stage.attempt), resultRef = resultVersionId(stage.jobId, stage.attempt);
  const asset = board.assets.find(row => row.versionId === resultRef), committed = commitSequence(board, resultRef);
  if (result === undefined || asset?.contentHash !== contentHashOf(result) || committed === undefined) return done();

  refs.add(resultRef);

  if (result.candidateVersionId !== undefined) {
    for (const ref of candidateProduction(board, plan, result, committed)) {
      refs.add(ref);
      outputs.add(ref);
    }
  }

  const decision = publishedDecision(board, plan, result, input.grantId, committed);
  if (decision !== undefined) {
    refs.add(decision);
    outputs.add(decision);
  }

  // A content-addressed contract proposal has no producing job/attempt in its
  // body. Concurrent jobs can publish/re-deliver the same hash even inside an
  // overlapping start/result interval; neither result refs nor that interval
  // identifies its first writer. Preserve navigation, never invent production.
  if (result.contractProposalId !== undefined) refs.add(result.contractProposalId);

  return done();
}

function candidateProduction(board: BoardState, plan: ToolLearningPlan, result: ToolLearningResult, resultSequence: number): readonly string[] {
  const versionId = result.candidateVersionId!, published = commitSequence(board, versionId);
  if (published === undefined || published > resultSequence) return [];

  const raw = decodeToolProductionPlan(board.assets.find(row => row.versionId === versionId)?.content);
  const production = raw === undefined ? undefined : productionIdentityFromBoard(board, versionId, raw.workspaceId);
  if (production?.ok && production.plan.type === "npm_tool_production_package") {
    const native = production.plan, original = native.evolution;
    return result.decision?.action === "adapt" && native.origin.scope === plan.scope && native.origin.capability === plan.capability
      && original?.parentVersionId === result.decision.parentVersionId && original.requestId === `${result.jobId}:${result.attempt}`
      && (native.learning === undefined || native.learning.jobId === result.jobId && native.learning.attempt === result.attempt)
      ? [versionId] : [];
  }

  if (raw !== undefined && production?.ok !== true) return [];

  const candidateId = production?.ok ? production.plan.origin.versionId : versionId;
  const candidate = candidateIdentityFromBoard(board, candidateId);
  const recipe = board.assets.find(row => row.versionId === result.recipeVersionId);
  const originSequence = commitSequence(board, candidateId);
  if (!candidate.ok || candidate.proposalId !== `proposal_${candidateId}` || originSequence === undefined || originSequence > published || recipe?.scope !== plan.scope
    || recipe.kind !== "verification_recipe" || recipe.contentHash !== contentHashOf(recipe.content)
    || !candidateBindsToolLearningRecipe(candidate.artifact.request, recipe.content, plan, result)) return [];

  if (production?.ok && (production.plan.type !== "tool_production_package" || production.plan.origin.scope !== plan.scope
    || production.plan.origin.capability !== plan.capability
    || production.plan.origin.contentHash !== board.assets.find(row => row.versionId === candidateId)?.contentHash)) return [];

  return [versionId];
}

function publishedDecision(board: BoardState, plan: ToolLearningPlan, result: ToolLearningResult, grantId: string, resultSequence: number): string | undefined {
  const decision = result.decision, versionId = result.decisionVersionId;
  if (versionId === undefined || decision === undefined || !["acquire", "reuse", "refine"].includes(decision.action)) return undefined;

  const asset = board.assets.find(row => row.versionId === versionId), published = commitSequence(board, versionId);
  if (asset?.kind !== "workflow" || asset.scope !== plan.scope || asset.source !== "inferred" || published === undefined || published > resultSequence
    || asset.contentHash !== contentHashOf(asset.content) || !recordOf(asset.content) || asset.content.type !== "tool_learning_decision"
    || asset.content.schemaVersion !== 1 || asset.content.jobId !== result.jobId || asset.content.attempt !== result.attempt
    || asset.content.grantId !== grantId || contentHashOf(asset.content.decision) !== contentHashOf(decision)
    || asset.content.step !== undefined && (typeof asset.content.step !== "number" || !Number.isSafeInteger(asset.content.step) || asset.content.step < 1)
    || versionId !== toolLearningDecisionVersionId({ jobId: result.jobId, attempt: result.attempt, decision,
      ...(asset.content.step === undefined ? {} : { step: asset.content.step }) })) return undefined;

  if (decision.action === "acquire") return result.search.candidates.some(row => row.platform === decision.candidate.platform
    && row.id === decision.candidate.id && row.version === decision.candidate.version) ? versionId : undefined;

  const selected = asset.content.selectedToolVersionId;

  return (decision.action === "reuse" || decision.action === "refine") && decision.usageContext !== undefined
    && typeof selected === "string" && board.assets.some(row => row.versionId === selected)
    ? versionId : undefined;
}

/** Original archive commit commands, never current state or wall-clock order. */
function commitSequence(board: BoardState, versionId: string): number | undefined {
  const asset = board.assets.find(row => row.versionId === versionId);
  if (asset === undefined) return undefined;

  const proposal = asset.createdFromProposalId;
  const commandId = proposal === `proposal_${versionId}` ? `${versionId}:commit`
    : proposal === `production-proposal:${versionId}` || proposal === `proposal:${versionId}` ? `${proposal}:commit` : undefined;
  const committed = board.appliedCommands.find(row => row.commandId === commandId);

  return committed !== undefined && Number.isSafeInteger(committed.sequence) && committed.sequence > 0 && committed.sequence <= board.sequence
    ? committed.sequence : undefined;
}
