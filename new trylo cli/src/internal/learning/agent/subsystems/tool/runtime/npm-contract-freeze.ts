import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { decodeNpmLearningContract, npmContractGrounded, NPM_LEARNING_CONTRACT_MAX_BYTES, type NpmLearningContract, type NpmLearningGrounding } from "../domain/evolution/npm-learning.js";
import { applyToolContractRevisions, preserveOrReviseToolSamples } from "../domain/evolution/contract-revision.js";
import { isJsonValue, jsonBytes, recordOf } from "../domain/evolution/parse.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { npmAdaptationParent } from "./npm-adaptation-parent.js";
import { npmContractGrounding, type npmContractBasis } from "./npm-contract-grounding.js";
import { readNpmLearningArtifact, saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { pipelineFailure } from "./pipeline-assets.js";

type Basis = Extract<Awaited<ReturnType<typeof npmContractBasis>>, { readonly ok: true }>;

export function canonicalNpmContractSnapshot(raw: unknown) {
  if (isJsonValue(raw) && jsonBytes(raw) > NPM_LEARNING_CONTRACT_MAX_BYTES) return pipelineFailure("npm_contract_snapshot_exceeds_limit", "The complete frozen contract and provenance exceed the bounded archive; no examples were dropped or oracle regenerated");
  const contract = decodeNpmLearningContract(raw);
  return contract === undefined ? pipelineFailure("npm_contract_grounding_mismatch", "Expected answers must preserve their exact frozen provenance")
    : { ok: true as const, contract };
}

export function npmFrozenContractId(input: NpmAdaptationInput): string {
  return `npm-contract_v1_${contentHashOf({ subjectId: input.admission.jobId, installationId: npmInstallId(input.installation),
    parent: npmAdaptationParent(input)?.versionId ?? null, adaptation: input.adaptation })}`;
}

export function npmFrozenBasis(input: NpmAdaptationInput, grounding: NpmLearningGrounding): NonNullable<NpmLearningContract["frozenBasis"]> {
  const parentVersionId = npmAdaptationParent(input)?.versionId;
  return { adaptationHash: contentHashOf(input.adaptation), grounding, ...(parentVersionId === undefined ? {} : { parentVersionId }) };
}

/** Locate a commitment before examining newly arrived feedback. A changed requirement
 * is not permission to ask another model for different held-out answers. */
export async function readNpmFrozenContract(input: NpmAdaptationInput, basis: Basis, grounding: NpmLearningGrounding) {
  const versionId = npmFrozenContractId(input), current = await readNpmLearningArtifact(input.boardRoot, versionId, input.plan.scope);
  if (!current.ok) return current;

  if (current.content !== undefined) {
    const contract = decodeNpmLearningContract(current.content);
    return contract !== undefined && frozenBinding(input, contract) ? { ok: true as const, versionId, contract }
      : pipelineFailure("npm_contract_binding_mismatch", "The stable npm task identity does not match its committed contract");
  }

  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const legacy = loaded.state.assets.filter(asset => asset.scope === input.plan.scope && recordOf(asset.content)
    && asset.content.type === "tool_npm_learning_contract" && asset.content.subjectId === input.admission.jobId
    && asset.content.installationId === npmInstallId(input.installation) && asset.content.frozenBasis === undefined);
  if (legacy.length === 0) return { ok: true as const, versionId, contract: undefined };

  if (legacy.length !== 1) return pipelineFailure("npm_contract_revision_required", "Multiple legacy commitments need an explicit contract decision; no new oracle was generated");

  const old = await readNpmLearningArtifact(input.boardRoot, legacy[0]!.versionId, input.plan.scope);
  if (!old.ok) return old;

  const contract = decodeNpmLearningContract(old.content);
  const oldKey = `npm-contract_v1_${contentHashOf({ subjectId: input.admission.jobId, installationId: npmInstallId(input.installation),
    parent: npmAdaptationParent(input)?.versionId ?? null, adaptation: input.adaptation,
    requirements: contentHashOf(grounding), offeredRevisions: basis.approvedRevisions.map(row => row.revisionId) })}`;
  const selected = contract === undefined ? undefined : npmContractGrounding(input, basis, contract.checks.contractRevisionRefs);
  if (contract === undefined || selected === undefined || !selected.ok || legacy[0]!.versionId !== oldKey || !npmContractGrounded(contract, selected.grounding)) {
    return pipelineFailure("npm_contract_revision_required", "Legacy grounding drift cannot safely reconstruct the frozen oracle; review the contract or start an explicit new task");
  }

  const migrated = { ...contract, frozenBasis: npmFrozenBasis(input, selected.grounding) };
  const canonical = canonicalNpmContractSnapshot(migrated);
  if (!canonical.ok) return canonical;

  const saved = await saveNpmLearningArtifact({ ...input, scope: input.plan.scope, versionId, content: migrated, issuedAt: new Date(input.now()).toISOString() });

  return saved.ok ? { ok: true as const, versionId, contract: migrated } : saved;
}

/** Corrections derive from the original commitment, retaining every synthesized
 * source/held-out case. This operation consumes zero model calls. */
export async function reviseNpmFrozenContract(input: NpmAdaptationInput, basis: Basis, base: { readonly versionId: string; readonly contract: NpmLearningContract }) {
  const parent = npmAdaptationParent(input), original = base.contract, existingRefs = original.checks.contractRevisionRefs ?? [];
  if (!frozenBinding(input, original) || existingRefs.some(ref => !basis.approvedRevisions.some(row => row.revisionId === ref))) {
    return pipelineFailure("contract_revision_unavailable", "A frozen correction was withdrawn or its exact parent binding changed");
  }

  if (parent === undefined) return { ok: true as const, ...base };

  const existing = basis.approvedRevisions.filter(row => existingRefs.includes(row.revisionId));
  const preserved = preserveOrReviseToolSamples({ parentVersionId: parent.versionId, scope: input.plan.scope,
    parentSamples: parent.checks.evidence, proposedSamples: original.checks.evidence, revisions: existing });
  if (!preserved.ok) return preserved;

  const refs = basis.approvedRevisions.map(row => row.revisionId).sort();
  if (refs.length > 8) return pipelineFailure("contract_revision_capacity", "Select a bounded, externally resolved correction set for this task");

  if (contentHashOf([...existingRefs].sort()) === contentHashOf(refs)) return { ok: true as const, ...base };

  const revised = applyToolContractRevisions({ parentVersionId: parent.versionId, scope: input.plan.scope,
    parentSamples: parent.checks.evidence, revisions: basis.approvedRevisions });
  if (!revised.ok) return revised;

  const replacements = new Map(revised.effectiveSamples.map(sample => [sample.sampleId, sample]));
  const revisionFor = (sampleId: string) => basis.approvedRevisions.find(row => row.proposal.corrections.some(change => change.sampleId === sampleId));
  const grounding: NpmLearningGrounding = { requirements: original.frozenBasis!.grounding.requirements,
    samples: original.frozenBasis!.grounding.samples.map(row => {
      const sample = replacements.get(row.sample.sampleId), revision = revisionFor(row.sample.sampleId);
      return sample === undefined || revision === undefined ? row : { ref: revision.revisionId, sample };
    }) };
  const decoded = canonicalNpmContractSnapshot({ ...original, groundingHash: contentHashOf(grounding), revisionOf: base.versionId,
    frozenBasis: npmFrozenBasis(input, grounding), checks: { ...original.checks, contractRevisionRefs: refs,
      evidence: original.checks.evidence.map(sample => replacements.get(sample.sampleId) ?? sample) },
    origins: original.origins.map(origin => { const revision = revisionFor(origin.sampleId);
      return revision === undefined ? origin : { ...origin, kind: "contract", ref: revision.revisionId }; }) });
  if (!decoded.ok) return decoded;

  const contract = decoded.contract;
  const versionId = `npm-contract-revised_v1_${contentHashOf({ baseContractId: base.versionId, revisionRefs: refs })}`;
  const saved = await saveNpmLearningArtifact({ ...input, scope: input.plan.scope, versionId, content: contract, issuedAt: new Date(input.now()).toISOString() });

  return saved.ok ? { ok: true as const, contract, versionId } : saved;
}

function frozenBinding(input: NpmAdaptationInput, contract: NpmLearningContract): boolean {
  const basis = contract.frozenBasis;
  if (basis === undefined) return false;
  return contract.subjectId === input.admission.jobId && contract.installationId === npmInstallId(input.installation)
    && contract.checks.scope === input.plan.scope && contract.checks.capability === input.plan.capability
    && basis.adaptationHash === contentHashOf(input.adaptation)
    && basis.parentVersionId === npmAdaptationParent(input)?.versionId;
}
