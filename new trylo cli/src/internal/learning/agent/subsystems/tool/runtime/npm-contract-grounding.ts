import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { NpmLearningGrounding } from "../domain/evolution/npm-learning.js";
import { applyToolContractRevisions, type ApprovedToolContractRevision } from "../domain/evolution/contract-revision.js";
import { approvedToolContractRevisionRecords } from "./contract-revision-reader.js";
import { npmAdaptationParent } from "./npm-adaptation-parent.js";
import { pipelineFailure } from "./pipeline-assets.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import type { NpmLearningContract } from "../domain/evolution/npm-learning.js";
import { TOOL_EVOLUTION_MAX_SAMPLES } from "../domain/evolution/contracts.js";
import { parseToolEvolutionSample, textOf } from "../domain/evolution/parse.js";
import { toolTaskTextRequirements } from "../domain/awareness/task-text.js";

export async function npmContractBasis(input: NpmAdaptationInput) {
  const explicit = input.plan.trigger.action === "user_requested" || input.plan.opportunity?.source === "user";
  const requirements = [...toolTaskTextRequirements(input.plan).map(({ ref, text }) => ({ ref, text })), ...(input.requirements ?? []), ...(explicit
    ? [{ ref: `requirement:${input.plan.trigger.proposalKey}`, text: input.plan.opportunity?.assessment.need ?? input.plan.capability }] : [])];
  const parent = npmAdaptationParent(input);
  if (parent !== undefined) requirements.push({ ref: `contract:${parent.versionId}`, text: parent.capability });

  let approvedRevisions: readonly ApprovedToolContractRevision[] = [];

  if (parent !== undefined) {
    const loaded = await createBoardReader(input.boardRoot).load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const revisions = approvedToolContractRevisionRecords(loaded.state, parent.versionId, input.plan.scope);
    if (!revisions.ok) return revisions;

    approvedRevisions = revisions.revisions;
    const compatible = applyToolContractRevisions({ parentVersionId: parent.versionId, scope: input.plan.scope,
      parentSamples: parent.checks.evidence, revisions: approvedRevisions });
    if (!compatible.ok) return compatible;
  }

  return { ok: true as const, requirements, approvedRevisions };
}

/** A selected approved revision changes only its exact expected answer; all other parent cases remain. */
export function npmContractGrounding(input: NpmAdaptationInput, basis: Extract<Awaited<ReturnType<typeof npmContractBasis>>, { readonly ok: true }>,
  revisionRefs: readonly string[] = []) {
  if (new Set(revisionRefs).size !== revisionRefs.length || revisionRefs.some(ref => !basis.approvedRevisions.some(row => row.revisionId === ref))) {
    return pipelineFailure("contract_revision_unavailable", "Expected-answer changes require an accepted revision for the exact parent");
  }

  const revisions = basis.approvedRevisions.filter(row => revisionRefs.includes(row.revisionId));
  const parent = npmAdaptationParent(input);
  const revised = parent === undefined ? { ok: true as const, effectiveSamples: [] } : applyToolContractRevisions({
    parentVersionId: parent.versionId, scope: input.plan.scope, parentSamples: parent.checks.evidence, revisions });
  if (!revised.ok) return revised;

  const parentSamples: NpmLearningGrounding["samples"][number][] = revised.effectiveSamples.map(sample => {
    const revision = revisions.find(row => row.proposal.corrections.some(correction => correction.sampleId === sample.sampleId
      && contentHashOf(correction.expected) === contentHashOf(sample.expected)));
    return { ref: revision?.revisionId ?? `${parent!.versionId}:${sample.sampleId}`, sample };
  });
  const grounded = input.plan.opportunity?.grounding;
  const samples = disclosedSamples(parentSamples, (grounded?.samples ?? []).map(sample => ({ ref: grounded!.reference, sample })));

  return samples.ok ? { ok: true as const, grounding: { requirements: basis.requirements, samples: samples.samples } satisfies NpmLearningGrounding } : samples;
}

type GroundedSample = NpmLearningGrounding["samples"][number];

/** One disclosed input is one regression case. Alias IDs/roles do not turn a
 * known answer into fresh evaluation, and source refs remain attached to it. */
function disclosedSamples(parent: readonly GroundedSample[], observed: readonly GroundedSample[]) {
  const samples: GroundedSample[] = [], inputs = new Map<string, number>(), ids = new Map<string, string>();

  for (const [rows, inherited] of [[parent, true], [observed, false]] as const) for (const row of rows) {
    const parsed = parseToolEvolutionSample(row.sample);
    if (!parsed.ok || !textOf(row.ref, 512)) return pipelineFailure("invalid_npm_grounding_sample", "Disclosed cases need canonical samples and bounded provenance references");

    const sample = parsed.value, inputHash = contentHashOf(sample.input), oldInput = ids.get(sample.sampleId);
    if (oldInput !== undefined && oldInput !== inputHash) return pipelineFailure("npm_contract_revision_required", "One disclosed sample ID identifies different inputs; explicitly correct that evidence identity before freezing a contract");

    ids.set(sample.sampleId, inputHash);
    const index = inputs.get(inputHash);
    if (index === undefined) {
      if (samples.length >= TOOL_EVOLUTION_MAX_SAMPLES) return pipelineFailure("npm_grounding_capacity", "More than 32 distinct disclosed inputs cannot fit the frozen contract; no parent checks or observed facts were dropped");
      inputs.set(inputHash, samples.length);
      samples.push({ ref: row.ref, sample, ...(row.aliases === undefined ? {} : { aliases: [...row.aliases] }) });
      continue;
    }

    const previous = samples[index]!;
    if (contentHashOf(previous.sample.expected) !== contentHashOf(sample.expected)) return pipelineFailure("npm_contract_revision_required", "The same disclosed input has conflicting expected answers; an exact externally approved correction is required before contract design");

    if (inherited && canonicalJson(previous.sample) !== canonicalJson(sample)) return pipelineFailure("npm_contract_revision_required", "The archived parent has different IDs or roles for one input; its oracle cannot be silently normalized");

    const aliases = [...new Set([...(previous.aliases ?? []), row.ref, ...(row.aliases ?? [])])].filter(ref => ref !== previous.ref);
    if (aliases.length > 16 || aliases.some(ref => !textOf(ref, 512))) return pipelineFailure("npm_grounding_reference_capacity", "Too many distinct references identify one disclosed input; no source references were removed");

    if (aliases.length > 0) samples[index] = { ...previous, aliases };
  }

  return { ok: true as const, samples };
}

/** Ordinary feedback can diagnose an implementation, but newly asserted acceptance
 * facts must not be treated as verified by an older set of checks. */
export function npmFrozenGroundingDrift(input: NpmAdaptationInput,
  basis: Extract<Awaited<ReturnType<typeof npmContractBasis>>, { readonly ok: true }>, contract: NpmLearningContract) {
  const current = npmContractGrounding(input, basis, contract.checks.contractRevisionRefs);
  if (!current.ok) return current;

  if (new Set(contract.checks.evidence.map(sample => contentHashOf(sample.input))).size !== contract.checks.evidence.length) {
    return pipelineFailure("npm_contract_revision_required", "The committed oracle repeats a disclosed input under multiple cases; review an explicit contract resolution or new task instead of silently rewriting old checks");
  }

  const frozen = contract.frozenBasis?.grounding;
  if (frozen === undefined) return pipelineFailure("npm_contract_revision_required", "The frozen grounding snapshot is unavailable");

  const approvedEvidence = new Set(basis.approvedRevisions.filter(row => contract.checks.contractRevisionRefs?.includes(row.revisionId))
    .flatMap(row => row.proposal.corrections.flatMap(change => change.evidenceRefs)));
  const requirements = current.grounding.requirements.filter(row => !frozen.requirements.some(old => canonicalJson(old) === canonicalJson(row))
    && !approvedEvidence.has(row.ref));
  const samples = current.grounding.samples.filter(row => !frozen.samples.some(old => canonicalJson(old.sample) === canonicalJson(row.sample)));

  return requirements.length === 0 && samples.length === 0 ? { ok: true as const } : pipelineFailure("npm_contract_revision_required",
    "Frozen checks remain intact. Newly supplied acceptance requirements are not covered by that oracle; review an exact correction or start an explicit new task");
}
