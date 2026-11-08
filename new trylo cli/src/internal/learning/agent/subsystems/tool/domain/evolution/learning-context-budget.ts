import type { ToolLearningContext } from "./learning-plan.js";
import { jsonBytes } from "./parse.js";
import { toolLearningPlanningPrompt, TOOL_PLANNING_INSTRUCTION } from "./learning-plan.js";
import { toolConstructionReserve } from "./learning-resources.js";
import { contentHashOf } from "../../../../../control/hash.js";
import type { ToolParentUsageHistory } from "./parent-usage.js";

/** Keep mandatory task/parent constraints intact; optional retrieval context fills remaining room. */
export function boundToolLearningContext(input: ToolLearningContext): ToolLearningContext | undefined {
  const limit = input.allowance.maxPromptChars;
  const grounding = input.plan.opportunity?.grounding;
  const plan = input.plan.opportunity === undefined ? input.plan : {
    ...input.plan, opportunity: { reportId: input.plan.opportunity!.reportId, source: input.plan.opportunity!.source,
      assessment: input.plan.opportunity!.assessment, executions: input.plan.opportunity!.executions },
  };
  const mandatoryPrior = input.plan.targetVersionId === undefined ? []
    : input.priorVersions.filter(prior => prior.versionId === input.plan.targetVersionId).map(planningSourceView);
  const mandatoryNpm = input.npmParents?.filter(parent => parent.versionId === input.plan.targetVersionId) ?? [];
  const mandatoryRevisions = input.contractRevisions?.filter(revision => [...mandatoryPrior, ...mandatoryNpm]
    .some(parent => parent.versionId === revision.proposal.parentVersionId)) ?? [];
  const mandatoryAnchors = input.contractAnchors?.filter(anchor => [...mandatoryPrior, ...mandatoryNpm]
    .some(parent => parent.versionId === anchor.parentVersionId)) ?? [];
  const usageView = (parents: readonly ToolParentUsageHistory[]) => {
    const omittedParentVersionIds = [...new Set([...(input.parentUsage?.omittedParentVersionIds ?? []),
      ...(input.parentUsage?.parents ?? []).filter(parent => !parents.some(kept => kept.parentVersionId === parent.parentVersionId)).map(parent => parent.parentVersionId)])];
    return { parents, omittedParentVersionIds,
      coverage: input.parentUsage?.coverage === "partial" || omittedParentVersionIds.length > 0 || parents.some(parent => parent.coverage === "partial")
        ? "partial" as const : "complete" as const };
  };
  const withParentUsage = (context: ToolLearningContext, parentVersionId: string): ToolLearningContext => {
    const group = input.parentUsage?.parents.find(parent => parent.parentVersionId === parentVersionId);
    if (group === undefined || context.parentUsage?.parents.some(parent => parent.parentVersionId === parentVersionId)) return context;
    return { ...context, parentUsage: usageView([...(context.parentUsage?.parents ?? []), group]) };
  };
  let result: ToolLearningContext = { ...input, plan, availableTools: [], priorVersions: mandatoryPrior,
    ...(input.reuseEvidence === undefined ? {} : { reuseEvidence: [] }),
    ...(input.parentUsage === undefined ? {} : { parentUsage: usageView([]) }),
    ...(input.npmParents === undefined ? {} : { npmParents: mandatoryNpm }),
    ...(input.research === undefined ? {} : { research: [] }), ...(input.history === undefined ? {} : { history: [] }),
    ...(input.contractRevisions === undefined ? {} : { contractRevisions: mandatoryRevisions }),
    ...(input.contractAnchors === undefined ? {} : { contractAnchors: mandatoryAnchors }),
    ...(input.observedTools === undefined ? {} : { observedTools: [] }),
    ...(input.productionFailures === undefined ? {} : { productionFailures: input.productionFailures.filter(failure =>
      input.plan.trigger.evidenceRefs.includes(failure.reportVersionId)) }),
    ...(input.acquisitionFailures === undefined ? {} : { acquisitionFailures: input.acquisitionFailures.filter(failure => input.plan.trigger.evidenceRefs.includes(failure.ref)
      || failure.ref === input.acquisitionInquiry?.failureRef) }),
    groundedSamples: input.groundedSamples.filter(sample => grounding?.reference === sample.ref
      || [...mandatoryPrior, ...mandatoryNpm].some(prior => sample.ref.startsWith(`${prior.versionId}:`))
      || mandatoryRevisions.some(revision => revision.revisionId === sample.ref)),
    search: { ...input.search, candidates: [], failures: input.search.failures.slice(0, 4) } };
  const withResources = (context: ToolLearningContext): ToolLearningContext => {
    const { reserve: _reserve, ...without } = context;
    return { ...without, reserve: toolConstructionReserve({ ...context.allowance,
      prompt: toolLearningPlanningPrompt(without),
      route: (context.npmParents?.length ?? 0) > 0 || context.priorVersions.length === 0 ? "npm_tool" : "pure_tool" }) };
  };
  const fits = (context: ToolLearningContext) => {
    const resourced = withResources(context);
    const prompt = toolLearningPlanningPrompt(resourced);
    // Packing owns the caller's material envelope. The funded provider quotes
    // actual input/output against the original remaining grant at dispatch;
    // a historical cost estimate is not another request ceiling.
    return jsonBytes(resourced) <= limit && TOOL_PLANNING_INSTRUCTION.length + prompt.length <= limit;
  };
  if (!fits(result)) return undefined;

  for (const failure of input.acquisitionFailures ?? []) {
    if (result.acquisitionFailures?.some(previous => previous.ref === failure.ref)) continue;
    const next = { ...result, acquisitionFailures: [...(result.acquisitionFailures ?? []), failure] };
    if (fits(next)) result = next;
  }

  // Historical conditions are an atomic group: omit with explicit partial
  // coverage when too large, never cut an exclusion to make a lesson fit.
  for (const parent of [...mandatoryPrior, ...mandatoryNpm]) {
    const next = withParentUsage(result, parent.versionId);
    if (fits(next)) result = next;
  }

  for (const failure of input.productionFailures ?? []) {
    if (result.productionFailures?.some(previous => previous.reportVersionId === failure.reportVersionId)) continue;
    const next = { ...result, productionFailures: [...(result.productionFailures ?? []), failure] };
    if (fits(next)) result = next;
  }

  const called = new Set(input.plan.opportunity?.executions.map(fact => fact.tool) ?? []);
  const observed = [...(input.observedTools ?? [])].sort((left, right) =>
    Number(right.tool === input.plan.trigger.tool) - Number(left.tool === input.plan.trigger.tool)
    || Number(called.has(right.tool)) - Number(called.has(left.tool)));

  for (const tool of observed.slice(0, 8)) {
    const next = { ...result, observedTools: [...(result.observedTools ?? []), tool] };
    if (fits(next)) result = next;
  }

  // The last failed approach and inspected interface outrank unrelated catalog entries.
  for (const previous of (input.history ?? []).slice(-4).reverse()) {
    const next = { ...result, history: [previous, ...(result.history ?? [])] };
    if (fits(next)) result = next;
  }

  const inspected = (input.research ?? []).flatMap(step => step.inspection === undefined ? [] : [step.inspection.candidate]);

  for (const candidate of input.search.candidates.filter(candidate => inspected.some(ref =>
    ref.platform === candidate.platform && ref.id === candidate.id && ref.version === candidate.version))) {
    const next = { ...result, search: { ...result.search, candidates: [...result.search.candidates, candidate] } };
    if (fits(next)) result = next;
  }

  for (const step of (input.research ?? []).slice(-8).reverse()) {
    const bounded = { ...step, ...(step.inspection === undefined ? {} : { inspection: { ...step.inspection,
      documents: step.inspection.documents.map(document => ({ ...document, text: document.text.slice(0, 4_000),
        truncated: document.truncated || document.text.length > 4_000 })) } }) };
    const next = { ...result, research: [bounded, ...(result.research ?? [])] };
    if (fits(next)) result = next;
  }

  for (const parent of input.npmParents ?? []) {
    if (mandatoryNpm.some(item => item.versionId === parent.versionId)) continue;

    const revisions = input.contractRevisions?.filter(revision => revision.proposal.parentVersionId === parent.versionId) ?? [];
    const samples = input.groundedSamples.filter(sample => sample.ref.startsWith(`${parent.versionId}:`) || revisions.some(revision => revision.revisionId === sample.ref));
    const next = { ...result, npmParents: [...(result.npmParents ?? []), parent], groundedSamples: [...result.groundedSamples, ...samples],
      ...(input.contractRevisions === undefined ? {} : { contractRevisions: [...(result.contractRevisions ?? []), ...revisions] }),
      ...(input.contractAnchors === undefined ? {} : { contractAnchors: [...(result.contractAnchors ?? []), ...input.contractAnchors.filter(anchor => anchor.parentVersionId === parent.versionId)] }) };
    const coupled = withParentUsage(next, parent.versionId);
    if (fits(coupled)) result = coupled;
    else if (fits(next)) result = next;
  }

  for (const tool of input.availableTools) {
    const reuse = input.reuseEvidence?.find(row => row.toolId === tool.toolId && row.versionId === tool.versionId);
    const next = { ...result, availableTools: [...result.availableTools, tool], ...(reuse === undefined ? {} : { reuseEvidence: [...(result.reuseEvidence ?? []), reuse] }) };
    if (fits(next)) result = next;
    else if (reuse !== undefined) {
      const minimal = { ...next, reuseEvidence: [...(result.reuseEvidence ?? []), { ...reuse, sameImplementationAs: [], taskAssessments: [] }] };
      if (fits(minimal)) result = minimal;
      else {
        const catalogOnly = { ...result, availableTools: [...result.availableTools, tool] };
        if (fits(catalogOnly)) result = catalogOnly;
      }
    }
  }

  for (const prior of input.priorVersions) {
    if (mandatoryPrior.some(item => item.versionId === prior.versionId)) continue;

    const revisions = input.contractRevisions?.filter(revision => revision.proposal.parentVersionId === prior.versionId) ?? [];
    const groundedSamples = input.groundedSamples.filter(sample => sample.ref.startsWith(`${prior.versionId}:`) || revisions.some(revision => revision.revisionId === sample.ref));
    const next = { ...result, priorVersions: [...result.priorVersions, planningSourceView(prior)], groundedSamples: [...result.groundedSamples, ...groundedSamples],
      ...(input.contractRevisions === undefined ? {} : { contractRevisions: [...(result.contractRevisions ?? []), ...revisions] }),
      ...(input.contractAnchors === undefined ? {} : { contractAnchors: [...(result.contractAnchors ?? []), ...input.contractAnchors.filter(anchor => anchor.parentVersionId === prior.versionId)] }) };
    const coupled = withParentUsage(next, prior.versionId);
    if (fits(coupled)) result = coupled;
    else if (fits(next)) result = next;
  }

  for (const sample of input.groundedSamples) {
    if (result.groundedSamples.some(item => item.ref === sample.ref && item.sample.sampleId === sample.sample.sampleId)) continue;
    const next = { ...result, groundedSamples: [...result.groundedSamples, sample] };
    if (fits(next)) result = next;
  }

  for (const candidate of input.search.candidates) {
    if (result.search.candidates.some(previous => previous.platform === candidate.platform && previous.id === candidate.id && previous.version === candidate.version)) continue;
    const next = { ...result, search: { ...result.search, candidates: [...result.search.candidates, candidate] } };
    if (fits(next)) result = next;
  }

  return withResources(result);
}

function planningSourceView(prior: ToolLearningContext["priorVersions"][number]): ToolLearningContext["priorVersions"][number] {
  if (prior.source === undefined || prior.source.length <= 4_000) return prior;
  const { source, ...metadata } = prior;
  return { ...metadata, sourceHash: contentHashOf(source), sourceExcerpt: source.slice(0, 4_000),
    sourceChars: source.length, excerptTruncated: true };
}
