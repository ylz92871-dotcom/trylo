import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan, ToolDiscoverySummary } from "../domain/evolution/pipeline.js";
import type { ToolLearningContext, ToolLearningAllowance } from "../domain/evolution/learning-plan.js";
import { isJsonValue } from "../domain/evolution/parse.js";
import { boundToolLearningContext } from "../domain/evolution/learning-context-budget.js";
import { toolLearningPriorVersions, toolLearningNpmParents, toolLearningFeedbackRequirements, toolLearningApprovedContracts } from "./learning-context.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import type { ToolPipelineServices } from "./pipeline-services.js";
import { toolPlanningResearch } from "./pipeline-research.js";
import { decodeToolLibraryInvestigation, type ToolResearchBoundary } from "../domain/evolution/research.js";
import { toolLearningProductionFailures } from "./production-check-reader.js";
import { toolLibraryReuseEvidence } from "./library-reuse-evidence.js";
import { orderToolReuseByContract } from "../domain/evolution/reuse-evidence.js";
import { toolTaskTextRequirements } from "../domain/awareness/task-text.js";
import { toolLearningAcquisitionFailures, toolAcquisitionFailureFromBoard } from "./acquisition-failure-reader.js";
import { acquisitionInquiryJobId, acquisitionInquirySpecId, decodeAcquisitionInquirySpec } from "../domain/evolution/acquisition-inquiry.js";
import { toolParentUsageContext } from "./parent-usage-context.js";
import { pureProductionPlanningParents } from "./pure-production-planning.js";
import { toolResearchRequirements } from "../domain/evolution/research-lineage.js";
import { previousToolPlanningFailure } from "./planning-response.js";

type Input = { readonly boardRoot: string; readonly plan: ToolLearningPlan; readonly jobId: string; readonly attempt: number;
  readonly search: ToolDiscoverySummary; readonly signal: AbortSignal;
  readonly services: Pick<ToolPipelineServices, "context" | "lookup" | "centralSourceContext">;
  readonly researchBoundary?: ToolResearchBoundary; readonly inquiryFailureRef?: string };

/** The original complete planning preparation, shared by quotes and execution.
 * It reads canonical material and optional read-only host context, never obtains
 * an allowance, invokes a model, starts a job or writes a result.
 */
export async function prepareToolPlanningContext(input: Input, allowance: ToolLearningAllowance) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const supplement = await input.services.context?.(input.plan, input.signal);
  const rejected = previousToolPlanningFailure(loaded.state, input.jobId, input.attempt - 1);
  if (!rejected.ok) return rejected;

  const researchRequirements = toolResearchRequirements(loaded.state, input.plan);
  if (researchRequirements === undefined) return pipelineFailure("invalid_tool_funding_origin", "Research successor materials lost their original binding");

  const prior = toolLearningPriorVersions(loaded.state, input.plan);
  if (!prior.ok) return prior;

  const priorVersions = prior.versions;
  const npm = toolLearningNpmParents(loaded.state, input.plan);
  if (!npm.ok) return npm;

  const parentUsage = toolParentUsageContext(loaded.state, { scope: input.plan.scope, plan: input.plan,
    parentVersionIds: [...priorVersions.map(parent => parent.versionId), ...npm.parents.map(parent => parent.versionId)],
    ...(input.plan.targetVersionId === undefined ? {} : { targetVersionId: input.plan.targetVersionId }) });
  if (!parentUsage.ok) return parentUsage;

  const productionParents = pureProductionPlanningParents(loaded.state, input.plan);
  if (!productionParents.ok) return productionParents;

  const feedbackRequirements = toolLearningFeedbackRequirements(loaded.state, input.plan);
  if (!feedbackRequirements.ok) return feedbackRequirements;

  const productionFailures = toolLearningProductionFailures(loaded.state, input.plan);
  if (!productionFailures.ok) return productionFailures;

  const acquisitionFailures = toolLearningAcquisitionFailures(loaded.state, input.plan);
  if (!acquisitionFailures.ok) return acquisitionFailures;

  let acquisitionInquiry: ToolLearningContext["acquisitionInquiry"];

  if (input.inquiryFailureRef !== undefined) {
    const observed = toolAcquisitionFailureFromBoard(loaded.state, input.inquiryFailureRef, input.plan.scope);
    const archived = loaded.state.assets.find(row => row.versionId === acquisitionInquirySpecId(input.jobId, input.attempt));
    const spec = archived === undefined ? undefined : decodeAcquisitionInquirySpec(archived.content);

    if (!observed.ok) return observed;

    if (spec === undefined || !assetAvailable(loaded.state, archived!) || spec.failureRef !== input.inquiryFailureRef || spec.scope !== input.plan.scope
      || input.jobId !== acquisitionInquiryJobId(observed.failure.jobId, observed.failure.decisionVersionId)) return pipelineFailure("invalid_inquiry_binding", input.jobId);

    acquisitionInquiry = { failureRef: input.inquiryFailureRef, originalJobId: observed.failure.jobId, approvalId: observed.failure.decisionVersionId };

    if (!acquisitionFailures.failures.some(row => row.ref === input.inquiryFailureRef)) {
      if (new Set(input.plan.trigger.evidenceRefs.filter(ref => ref.startsWith("tool-acquisition-failure_v1_"))).size >= 8) return pipelineFailure("acquisition_failure_context_limit", input.jobId);
      acquisitionFailures.failures.unshift(observed.failure);
      if (acquisitionFailures.failures.length > 8) acquisitionFailures.failures.pop();
    }
  }

  const investigation = toolPlanningResearch(loaded.state, input.plan, input.jobId);
  if (!investigation.ok) return investigation;

  const contractParents = [...priorVersions, ...npm.parents.map(parent => ({ versionId: parent.versionId, evidence: parent.checks.evidence }))];
  const contracts = toolLearningApprovedContracts(loaded.state, input.plan, contractParents);
  if (!contracts.ok) return contracts;

  const grounding = input.plan.opportunity?.grounding;
  const explicitRequirement = input.plan.trigger.action === "user_requested" || input.plan.opportunity?.source === "user";
  const lookupQueries = [...new Set([...investigation.research].reverse().flatMap(step => step.library === undefined ? [] : [step.library.query]))].slice(0, 2);
  const refreshed = input.services.lookup === undefined ? [] : await Promise.all(lookupQueries.map(async query =>
    decodeToolLibraryInvestigation(await input.services.lookup!(query, input.plan, input.signal))));
  if (refreshed.some(item => item === undefined)) return pipelineFailure("invalid_research_result", "local library revalidation exceeded its contract");

  // Historical research can guide a query; only a current host read can expose a reusable tool.
  const offeredTools = [...new Map(refreshed.flatMap(item => item?.candidates ?? [])
    .concat(supplement?.availableTools ?? []).map(tool => [tool.toolId, tool])).values()];
  const reuse = toolLibraryReuseEvidence(loaded.state, input.plan.scope, offeredTools,
    [...(supplement?.groundedSamples ?? []), ...(grounding?.samples.map(sample => ({ ref: grounding.reference, sample })) ?? [])]);
  if (!reuse.ok) return reuse;

  const availableTools = orderToolReuseByContract(offeredTools, reuse.evidence, input.plan.targetVersionId);
  // The last funded call must interpret what is already known. Do not invite
  // more investigation whose result this same grant cannot then consider.
  const researchBoundary = input.researchBoundary ?? (allowance.callsRemaining <= 1
    ? { furtherInvestigation: "closed" as const, reason: "research_capacity" as const } : undefined);
  const unbounded: ToolLearningContext = { plan: input.plan, search: input.search, allowance,
    ...(rejected.failure === undefined ? {} : { planningFailure: rejected.failure }),
    ...(input.services.centralSourceContext === undefined ? {} : { centralSourceContext: input.services.centralSourceContext }),
    priorVersions, npmParents: npm.parents, parentUsage: parentUsage.context, research: investigation.research, history: investigation.history,
    ...(productionParents.parents.length === 0 ? {} : { pureProductionParents: productionParents.parents }),
    contractRevisions: contracts.revisions, productionFailures: productionFailures.failures,
    acquisitionFailures: acquisitionFailures.failures,
    ...(acquisitionInquiry === undefined ? {} : { acquisitionInquiry }),
    contractAnchors: [...contractParents.map(parent => ({ parentVersionId: parent.versionId, parentContractHash: contentHashOf(parent.evidence),
      samples: parent.evidence.map(sample => ({ sampleId: sample.sampleId, sampleHash: contentHashOf(sample), expectedHash: contentHashOf(sample.expected) })) })),
      ...productionParents.parents.map(parent => ({ parentVersionId: parent.versionId, parentContractHash: parent.parentContractHash,
        samples: parent.sourceSamples.map(sample => ({ sampleId: sample.sampleId, sampleHash: contentHashOf(sample), expectedHash: contentHashOf(sample.expected) })) }))],
    ...(input.plan.opportunity?.catalog === undefined ? {} : { observedTools: input.plan.opportunity.catalog }),
    ...(researchBoundary === undefined ? {} : { researchBoundary }),
    availableTools, reuseEvidence: reuse.evidence,
    requirements: [...researchRequirements, ...toolTaskTextRequirements(input.plan), ...(supplement?.requirements ?? (explicitRequirement
      ? [{ ref: `requirement:${input.plan.trigger.proposalKey}`, kind: "user_requirement" as const, text: input.plan.opportunity?.assessment.need ?? input.plan.capability }] : [])), ...feedbackRequirements.requirements],
    groundedSamples: [...(supplement?.groundedSamples ?? []),
      ...(grounding?.samples.map(sample => ({ ref: grounding.reference, sample })) ?? []),
      ...priorVersions.flatMap(prior => prior.evidence.map(sample => ({ ref: `${prior.versionId}:${sample.sampleId}`, sample }))),
      ...npm.parents.flatMap(parent => parent.checks.evidence.map(sample => ({ ref: `${parent.versionId}:${sample.sampleId}`, sample }))),
      ...contracts.samples ] };
  if (!isJsonValue(unbounded)) return pipelineFailure("invalid_learning_context", "host context must contain finite JSON data");

  const context = boundToolLearningContext(unbounded);
  if (context === undefined) return pipelineFailure("planning_context_exceeds_allowance", "mandatory task/parent constraints exceed central prompt allowance");

  return { ok: true as const, state: loaded.state, context, researchBoundary, productionFailures };
}
