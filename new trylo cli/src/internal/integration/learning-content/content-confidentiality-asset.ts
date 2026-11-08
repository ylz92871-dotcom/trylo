import type { ContentMaterialBatch } from "../../learning/central/content/material-contract.js";
import { ACTIVATION_POINTERS, PROPOSAL_SOURCES, isAssetKind, isMethodFielding, type MethodFielding } from "../../learning/control/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { boardAssetContentRef, boardAssetProjectionRunId } from "./sources/artifact.js";
import { isContentValueCredentialSafe } from "./content-confidentiality-leaf.js";
import type { TrustedContentIdentity } from "./content-confidentiality.js";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function parsed(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

/** A check-only view of a cross-bound original Board asset projection. None of these
 * substitutions is returned to a model, persisted, or used as the asset's content/hash. */
export function contentAssetConfidentialityView(batch: ContentMaterialBatch, trusted: TrustedContentIdentity,
  secrets: readonly string[]): ContentMaterialBatch | undefined {
  let result = batch;

  for (const material of batch.materials) {
    const context = parsed(material.context);
    if (!object(context) || context.source !== "Board.assets.content") continue;

    if (!fields(context, ["source", "originalScope", "versionId", "contentHash", "createdAt", "sourceRefs", "coordinateKind"])
      || context.coordinateKind !== "explicit_board_asset_projection" || typeof context.originalScope !== "string"
      || !identity(context.versionId) || !hash(context.contentHash) || typeof context.createdAt !== "string" || !Array.isArray(context.sourceRefs)
      || !context.sourceRefs.every(identity) || !isContentValueCredentialSafe(context, secrets)) return undefined;

    const ref = boardAssetContentRef({ scope: context.originalScope, versionId: context.versionId, contentHash: context.contentHash });
    const runId = boardAssetProjectionRunId({ scope: trusted.scope, versionId: context.versionId });
    const content = batch.records.find(row => row.ref === ref && material.recordRefs.includes(row.ref));
    if (material.id !== ref || content?.runId !== runId || content.sequence !== 0 || content.origin !== "model_proposal") return undefined;

    const body = parsed(content.text);
    if (body === undefined || canonicalJson(body) !== content.text || contentHashOf(body) !== context.contentHash) return undefined;

    const receipt = batch.records.find(row => row.runId === runId && row.sequence === 1 && row.origin === "execution_result" && material.recordRefs.includes(row.ref));
    if (receipt === undefined) return undefined;

    const raw = parsed(receipt.text);
    if (!fields(raw, ["role", "originalScope", "knownAtBoardSequence", "assetVersionId", "contentHash", "activationState", "activations", "fieldings", "toolUses", "rewardExposures", "evidence"])
      || raw.role !== "source_owned_activation_and_actual_adoption_records_not_learning_gain" || raw.originalScope !== context.originalScope
      || raw.assetVersionId !== context.versionId || raw.contentHash !== context.contentHash || !sequence(raw.knownAtBoardSequence)
      || !["not_active", "active", "inactive"].includes(String(raw.activationState)) || !Array.isArray(raw.activations)
      || !Array.isArray(raw.fieldings) || !Array.isArray(raw.toolUses) || !Array.isArray(raw.rewardExposures) || !Array.isArray(raw.evidence)
      || receipt.ref !== `board-asset-receipts:${contentHashOf([trusted.scope, raw.knownAtBoardSequence, context.versionId, context.versionId])}`
      || !isContentValueCredentialSafe(raw, secrets)) return undefined;

    const activations: Record<string, unknown>[] = [];

    for (const activation of raw.activations) {
      if (!object(activation) || !identity(activation.activationId) || typeof activation.scope !== "string" || typeof activation.assetKind !== "string"
        || !isAssetKind(activation.assetKind) || !ACTIVATION_POINTERS.some(pointer => pointer === activation.pointer) || activation.versionId !== context.versionId
        || !sequence(activation.boardSequence) || !sequence(activation.generation)) return undefined;
      const current = activation.scope === trusted.scope;
      activations.push({ ...activation, scope: current ? "[canonical_scope]" : activation.scope,
        activationId: current && activation.activationId === `act:${trusted.scope}:${activation.assetKind}` ? "[canonical_activation_identity]" : activation.activationId });
    }

    const fieldings: MethodFielding[] = [];

    for (const fielding of raw.fieldings) {
      if (!isMethodFielding(fielding) || fielding.versionId !== context.versionId) return undefined;
      // A real same-version fielding remains source evidence. Only the exact admitted
      // workspace scope is metadata; other fields retain the original prose policy.
      fieldings.push({ ...fielding, scope: fielding.scope === trusted.scope ? "[canonical_scope]" : fielding.scope });
    }

    const answer = batch.answers.find(row => row.answerId === ref && row.supportRefs.includes(ref) && row.supportRefs.includes(receipt.ref)
      && row.artifactRefs.some(item => item.id === context.versionId && item.version === context.versionId));
    const condition = answer?.conditions[0] === undefined ? undefined : parsed(answer.conditions[0]);
    if (answer === undefined || !fields(condition, ["originalScope", "kind", "source", "activationState", "activationPointers", "verificationEvidenceRefs"])
      || condition.originalScope !== context.originalScope || typeof condition.kind !== "string" || !isAssetKind(condition.kind)
      || !PROPOSAL_SOURCES.some(source => source === condition.source) || condition.activationState !== raw.activationState
      || canonicalJson(condition.activationPointers) !== canonicalJson(raw.activations.map(item => object(item)
        ? { pointer: item.pointer, generation: item.generation, breaker: item.breaker ?? null } : null))
      || canonicalJson(condition.verificationEvidenceRefs) !== canonicalJson(raw.evidence.map(item => object(item) ? item.evidenceId : null))
      || !isContentValueCredentialSafe(condition, secrets)) return undefined;

    const originalScope = context.originalScope === trusted.scope ? "[canonical_scope]" : context.originalScope;

    result = { ...result,
      records: result.records.map(row => row.ref === receipt.ref ? { ...row, text: canonicalJson({ ...raw, originalScope, activations, fieldings }) } : row),
      materials: result.materials.map(row => row.id === material.id ? { ...row, context: canonicalJson({ ...context, originalScope }) } : row),
      answers: result.answers.map(row => row.answerId === answer.answerId ? { ...row,
        conditions: [canonicalJson({ ...condition, originalScope }), ...row.conditions.slice(1)] } : row) };
  }

  return result;
}
