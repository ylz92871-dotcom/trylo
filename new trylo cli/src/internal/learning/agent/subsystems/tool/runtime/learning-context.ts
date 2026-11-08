import type { BoardState } from "../../../../control/state.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { prepareToolImprovement } from "./evolution-trials.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import type { ToolLearningContext, ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolUseFeedback } from "../domain/evolution/use.js";
import { toolTaskFeedbackContext } from "./tool-task-feedback.js";
import type { PipelineFailure } from "./pipeline-assets.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import type { ToolLearningNpmParent } from "../domain/evolution/learning-parent.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { toolLearningFeedbackScope } from "./feedback-input-facts.js";
import { applyToolContractRevisions, preserveOrReviseToolSamples, previewToolContractRevision, type ApprovedToolContractRevision } from "../domain/evolution/contract-revision.js";
import { approvedToolContractRevisionsFromBoard } from "./contract-revisions.js";
import type { ToolEvolutionSample } from "../domain/evolution/contracts.js";
import { toolInternalRecipeVersionId } from "../domain/evolution/decision-identity.js";

/** Only immutable candidate readers supply executable parent source; catalog text never does. */
export function toolLearningPriorVersions(state: BoardState, plan: ToolLearningPlan): PipelineFailure | { readonly ok: true;
  readonly versions: readonly (ToolLearningContext["priorVersions"][number] & { readonly source: string })[] } {
  const result: (ToolLearningContext["priorVersions"][number] & { readonly source: string })[] = [];
  const targetVersionId = requestedParentVersion(state, plan);
  if (targetVersionId !== undefined) {
    const target = toolLearningParentFromBoard(state, targetVersionId);
    if (!target.ok) return target;
    if (target.parent.scope !== plan.scope) return pipelineFailure("planning_scope_mismatch", "the exact learning parent belongs to another workspace");
  }

  const assets = [...state.assets].reverse().sort((left, right) =>
    Number(matchesCapability(right.content, plan.capability)) - Number(matchesCapability(left.content, plan.capability)));

  for (const asset of assets) {
    if (asset.kind !== "tool_package" || asset.scope !== plan.scope || (targetVersionId === undefined && !assetAvailable(state, asset))) continue;

    if (targetVersionId !== undefined && asset.versionId !== targetVersionId) continue;

    const historical = targetVersionId === undefined ? undefined : toolLearningParentFromBoard(state, asset.versionId);
    if (historical !== undefined && !historical.ok) return historical;

    const candidate = targetVersionId === undefined ? candidateFromBoard(state, asset.versionId) : undefined;
    const artifact = historical?.ok && historical.parent.kind === "generated" ? historical.parent.artifact : candidate?.ok ? candidate.artifact : undefined;
    if (artifact === undefined) continue;

    const request = artifact.request;
    const taskFeedback = toolLearningFeedbackScope(state, plan, asset.versionId);
    if (!taskFeedback.ok) return taskFeedback;

    const feedback = scopedFeedbackText(taskFeedback);

    result.push({ versionId: asset.versionId, capability: request.capability, source: artifact.candidate.source,
      evidence: request.evidence, feedback });

    if (result.length === 4) break;
  }

  return { ok: true, versions: result };
}

/** Existing library requests already carry the exact source reference in evidenceRefs.
 * Resolve that legacy binding without rewriting the immutable plan or its job identity. */
function requestedParentVersion(state: BoardState, plan: ToolLearningPlan): string | undefined {
  if (plan.targetVersionId !== undefined) {
    const selected = toolLearningParentFromBoard(state, plan.targetVersionId);
    return selected.ok ? selected.parent.versionId : plan.targetVersionId;
  }

  if (plan.trigger.tool === undefined) return undefined;

  const references = [...plan.trigger.evidenceRefs, ...(plan.opportunity?.executions.flatMap(fact =>
    fact.versionId === undefined || fact.tool !== plan.trigger.tool ? [] : [fact.versionId]) ?? [])];
  const asset = references.reverse().map(ref => state.assets.find(item => item.versionId === ref))
    .find(item => item?.kind === "tool_package");
  if (asset === undefined) return undefined;

  const selected = toolLearningParentFromBoard(state, asset.versionId);

  return selected.ok ? selected.parent.versionId : asset.versionId;
}

/** External package parents stay separate from dependency-free function parents.
 * The adapter and frozen interface contract are exact, but the large installation
 * closure is loaded only when the separately authorized adaptation runs. */
export function toolLearningNpmParents(state: BoardState, plan: ToolLearningPlan): PipelineFailure | {
  readonly ok: true; readonly parents: readonly ToolLearningNpmParent[];
} {
  const parents: ToolLearningNpmParent[] = [];
  const target = requestedParentVersion(state, plan);

  for (const asset of [...state.assets].reverse()) {
    if (asset.kind !== "tool_package" || (target === undefined && !assetAvailable(state, asset)) || (target !== undefined && asset.versionId !== target)) continue;

    const production = decodeToolProductionPlan(asset.content);
    if (production?.type !== "npm_tool_production_package" || production.origin.scope !== plan.scope) continue;

    if (target === undefined && production.origin.capability !== plan.capability) continue;

    const selected = toolLearningParentFromBoard(state, asset.versionId);
    if (!selected.ok) return selected;

    const feedback = toolLearningFeedbackScope(state, plan, asset.versionId);
    if (!feedback.ok) return feedback;

    const root = production.installation.tree.root;

    parents.push({ versionId: asset.versionId, contentHash: contentHashOf(production), capability: production.origin.capability,
      descriptor: production.candidate, runtime: production.runtime, checks: production.checks,
      installationId: production.origin.versionId, package: { name: root.name, version: root.version },
      feedback: scopedFeedbackText(feedback) });

    if (parents.length === 4) break;
  }

  if (target !== undefined && parents.length === 0) {
    const asset = state.assets.find(item => item.versionId === target);
    if (decodeToolProductionPlan(asset?.content)?.type === "npm_tool_production_package") {
      return pipelineFailure("learning_parent_unavailable", "the exact npm parent cannot be reconstructed within its learning scope");
    }
  }

  return { ok: true, parents };
}

/** Only independently supplied user/verifier text may ground newly synthesized
 * checks. A model's causal hypothesis stays in feedback, not in the oracle. */
export function toolLearningFeedbackRequirements(state: BoardState, plan: ToolLearningPlan): PipelineFailure | {
  readonly ok: true; readonly requirements: ToolLearningContext["requirements"];
} {
  const target = requestedParentVersion(state, plan);
  if (target === undefined) return { ok: true, requirements: [] };

  const feedback = toolLearningFeedbackScope(state, plan, target);
  if (!feedback.ok) return feedback;

  const triggering = new Set(plan.trigger.evidenceRefs);
  const ordered = [...feedback.entries].reverse().sort((left, right) =>
    Number(triggering.has(right.feedbackVersionId)) - Number(triggering.has(left.feedbackVersionId)));
  const requirements: ToolLearningContext["requirements"][number][] = [];

  for (const entry of ordered) {
    if (entry.feedback.source !== "user" && entry.feedback.source !== "verifier") continue;
    requirements.push({ ref: entry.feedbackVersionId, kind: entry.feedback.source === "user" ? "user_requirement" : "external_contract",
      text: `Situation: ${entry.feedback.situation}. Task assessment (${entry.feedback.outcome}; attribution=${entry.feedback.attribution}): ${entry.feedback.summary}` });
    if (requirements.length === 8) break;
  }

  return { ok: true, requirements };
}

function scopedFeedbackText(feedback: Extract<ReturnType<typeof toolLearningFeedbackScope>, { readonly ok: true }>): string {
  return feedback.historyScope === "unknown" ? "Historical feedback workspace is unknown; no unbound assessments are presented. This does not prove that no history exists."
    : [toolUseFeedback(feedback.uses), toolTaskFeedbackContext(feedback.entries.map(entry => entry.feedback))]
      .filter(Boolean).join("\n") || "No attributed feedback is available in the exact source workspace.";
}

function matchesCapability(content: unknown, capability: string): boolean {
  if (typeof content !== "object" || content === null || !("request" in content)) return false;
  const request = content.request;
  return typeof request === "object" && request !== null && "capability" in request && request.capability === capability;
}

export function decisionBindingFailure(decision: ToolLearningDecision, context: ToolLearningContext): string | undefined {
  if (decision.action === "reuse" || decision.action === "refine") {
    if (!context.availableTools.some(tool => tool.toolId === decision.toolId)) return "unknown_existing_tool";
    const evidence = planningEvidenceRefs(context);
    return decision.usageContext?.evidenceRefs.some(ref => !evidence.has(ref)) ? "usage_evidence_missing" : undefined;
  }

  if (decision.action === "revise_contract") {
    const parent = context.priorVersions.find(item => item.versionId === decision.proposal.parentVersionId);
    const npm = context.npmParents?.find(item => item.versionId === decision.proposal.parentVersionId);
    const production = context.pureProductionParents?.find(item => item.versionId === decision.proposal.parentVersionId);
    const samples = parent?.evidence ?? npm?.checks.evidence ?? production?.sourceSamples;
    if (samples === undefined || decision.proposal.scope !== context.plan.scope) return "planning_parent_mismatch";

    const evidence = new Set(context.requirements.filter(requirement => requirement.kind === "user_requirement"
      || requirement.kind === "external_contract").map(requirement => requirement.ref));
    if (decision.proposal.corrections.some(correction => correction.evidenceRefs.some(ref => !evidence.has(ref)))) return "contract_revision_evidence_missing";

    if (production !== undefined && decision.proposal.parentContractHash !== production.parentContractHash) return "contract_revision_parent_mismatch";

    // Only the disclosed subset is model-addressable. The Board writer repeats
    // this preview against the complete original production contract.
    const preview = previewToolContractRevision({ parentVersionId: decision.proposal.parentVersionId, scope: context.plan.scope,
      parentSamples: samples, proposal: production === undefined ? decision.proposal
        : { ...decision.proposal, parentContractHash: contentHashOf(samples) } });

    return preview.ok ? undefined : preview.code;
  }

  if (decision.action === "acquire") {
    if (decision.candidate.platform !== "npm") return "acquisition_runtime_unsupported";
    return context.search.candidates.some(candidate => candidate.platform === decision.candidate.platform
      && candidate.id === decision.candidate.id && candidate.version === decision.candidate.version) ? undefined : "unknown_discovery_candidate";
  }

  if (decision.action === "adapt") return context.npmParents?.some(parent => parent.versionId === decision.parentVersionId)
    ? undefined : "planning_parent_mismatch";

  if (!("request" in decision)) return undefined;

  if (decision.action !== "improve" && (decision.request.contractRevisionRefs?.length ?? 0) > 0) return "contract_revision_parent_required";

  if (decision.request.scope !== context.plan.scope || decision.request.capability !== context.plan.capability) return "planning_scope_mismatch";

  const ground = decision.sampleOrigins.filter(origin => origin.kind !== "synthesized");
  if (ground.length === 0 && !decision.sampleOrigins.some(origin => context.requirements.some(requirement => requirement.ref === origin.ref))) return "independent_sample_required";

  for (const origin of ground) {
    const trusted = context.groundedSamples.find(sample => sample.ref === origin.ref && sample.sample.sampleId === origin.sampleId);
    const proposed = decision.request.evidence.find(sample => sample.sampleId === origin.sampleId);
    if (trusted === undefined || proposed === undefined || canonicalJson(trusted.sample) !== canonicalJson(proposed)) return "sample_grounding_mismatch";
  }

  if (decision.sampleOrigins.some(origin => origin.kind === "synthesized" && !context.requirements.some(requirement => requirement.ref === origin.ref))) return "sample_requirement_missing";

  if (decision.action === "improve") {
    const prior = context.priorVersions.find(item => item.versionId === decision.request.prior?.versionId);
    const sourceHash = prior?.sourceHash ?? (prior?.source === undefined ? undefined : contentHashOf(prior.source));
    if (prior === undefined || sourceHash === undefined || decision.request.prior === undefined
      || sourceHash !== contentHashOf(decision.request.prior.source)) return "planning_parent_mismatch";

    const refs = decision.request.contractRevisionRefs ?? [];
    const revisions = (context.contractRevisions ?? []).filter(revision => refs.includes(revision.revisionId));
    if (revisions.length !== refs.length) return "contract_revision_not_approved";

    const preserved = preserveOrReviseToolSamples({ parentVersionId: prior.versionId, scope: context.plan.scope,
      parentSamples: prior.evidence, proposedSamples: decision.request.evidence, revisions });
    if (!preserved.ok) return preserved.code;
  }

  if (decision.action === "create" || decision.action === "compose") {
    const target = context.priorVersions.find(prior => prior.versionId === context.plan.targetVersionId);
    if (target !== undefined) {
      const preserved = preserveOrReviseToolSamples({ parentVersionId: target.versionId, scope: context.plan.scope,
        parentSamples: target.evidence, proposedSamples: decision.request.evidence, revisions: [] });
      if (!preserved.ok) return preserved.code;
    }
  }

  return undefined;
}

function planningEvidenceRefs(context: ToolLearningContext): ReadonlySet<string> {
  return new Set([...context.plan.trigger.evidenceRefs, ...context.requirements.map(item => item.ref),
    ...context.groundedSamples.map(item => item.ref), ...context.priorVersions.map(item => item.versionId),
    ...(context.npmParents?.map(item => item.versionId) ?? []),
    ...(context.parentUsage?.parents.flatMap(parent => parent.sources.flatMap(source => source.lessons.flatMap(lesson =>
      [lesson.decisionVersionId, ...lesson.assessments.map(assessment => assessment.feedbackRef)]))) ?? []),
    ...(context.research?.flatMap(step => step.inspection?.documents.flatMap(document => [document.sourceUrl, document.contentHash]) ?? []) ?? [])]);
}

/** Approved corrections are independent ground truth; old parent checks remain visible as history. */
export function toolLearningApprovedContracts(state: BoardState, plan: ToolLearningPlan,
  parents: readonly { readonly versionId: string; readonly evidence: readonly ToolEvolutionSample[] }[]) {
  const revisions: ApprovedToolContractRevision[] = [], samples: ToolLearningContext["groundedSamples"][number][] = [];

  for (const parent of parents) {
    const approved = approvedToolContractRevisionsFromBoard(state, parent.versionId, plan.scope);
    if (!approved.ok) return approved;

    const applied = applyToolContractRevisions({ parentVersionId: parent.versionId, scope: plan.scope, parentSamples: parent.evidence, revisions: approved.revisions });
    if (!applied.ok) return applied;

    revisions.push(...approved.revisions);

    for (const revision of approved.revisions) for (const correction of revision.proposal.corrections) {
      const sample = applied.effectiveSamples.find(item => item.sampleId === correction.sampleId);
      if (sample !== undefined) samples.push({ ref: revision.revisionId, sample });
    }
  }

  return { ok: true as const, revisions, samples };
}

export async function prepareLearningRequest(boardRoot: string, decision: Extract<ToolLearningDecision, { readonly request: unknown }>, plan?: ToolLearningPlan) {
  if (decision.action !== "improve" || decision.request.prior === undefined) return { ok: true as const, request: decision.request, feedback: "" };
  const prepared = await prepareToolImprovement(boardRoot, decision.request.prior.versionId, decision.request, plan);
  return prepared.ok ? { ok: true as const, request: prepared.request, feedback: prepared.feedback ?? "" } : prepared;
}

export function autonomousRecipeVersionId(decision: ToolLearningDecision): string {
  return toolInternalRecipeVersionId(decision);
}
