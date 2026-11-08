import { createBoardReader, withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import type { FileBoardStoreOptions } from "../../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand, ProposalDraft } from "../../../../../control/commands.js";
import type { LearningAssetVersion } from "../../../../../control/contracts.js";
import { contentHashOf } from "../../../../../control/hash.js";
import type { BoardState } from "../../../../../control/state.js";
import type { BoardStore } from "../../../../../control/store-port.js";
import { isIso8601 } from "../../../../../../ports/approval-consumption.js";

export const CHECK_ARTIFACT_PREFIX = "check:";
export const CHECKER_ARTIFACT_PREFIX = "checker:";
export const MAX_CHECK_ARTIFACTS = 512;

export type CheckBoardFailure = { readonly ok: false; readonly code: string; readonly message: string };

export type CheckArtifactInput = {
  readonly versionId: string;
  readonly kind: "verification_recipe" | "workflow";
  readonly scope: string;
  readonly source: "user_explicit" | "inferred";
  readonly sourceRefs: readonly string[];
  readonly content: unknown;
  readonly parentVersionId?: string;
  readonly issuedAt: string;
  readonly hypothesis: string;
};

type SavedCheckArtifact = { readonly ok: true; readonly versionId: string; readonly idempotent: boolean };

function failure(code: string, message: string): CheckBoardFailure {
  return { ok: false, code, message };
}

/** One Board writer; data admission grants neither an activation nor an independent verdict. */
export async function writeCheckArtifact(boardRoot: string, input: CheckArtifactInput,
  options: FileBoardStoreOptions = {}): Promise<SavedCheckArtifact | CheckBoardFailure> {
  const result = await withBoardWriter(boardRoot, store => saveCheckArtifact(store, input), options);
  return "reason" in result ? failure(result.reason, result.detail) : result;
}

/** Call only while owning Board's writer. Stable command IDs resume a partially appended sequence. */
export async function saveCheckArtifact(store: BoardStore, input: CheckArtifactInput): Promise<SavedCheckArtifact | CheckBoardFailure> {
  if (!validInput(input) || !serializableContent(input.content)) {
    return failure("check_artifact_invalid", "check artifact identity, metadata or JSON content is invalid");
  }

  const loaded = await store.load();
  if (!loaded.ok) return failure(loaded.reason, loaded.detail);

  const state = loaded.state;
  const proposal = proposalOf(input);
  const previousProposal = state.proposals.find(item => item.proposalId === proposal.proposalId);
  if (previousProposal !== undefined) {
    const { lifecycle, ...previousDraft } = previousProposal;
    if (contentHashOf(previousDraft) !== contentHashOf(proposal)) return failure("check_artifact_conflict", input.versionId);
    if (lifecycle !== "draft" && lifecycle !== "quarantined" && lifecycle !== "evaluating") {
      return failure("check_artifact_unavailable", input.versionId);
    }
  }

  if (isWithdrawn(state, input.versionId, proposal.proposalId)) return failure("check_artifact_unavailable", input.versionId);

  const existing = state.assets.find(asset => asset.versionId === input.versionId);
  if (existing !== undefined) {
    return isCheckAssetAvailable(state, existing) && existing.kind === input.kind && existing.scope === input.scope
      && existing.source === input.source && existing.contentHash === contentHashOf(input.content)
      && existing.parentVersionId === input.parentVersionId
      ? { ok: true, versionId: input.versionId, idempotent: true }
      : failure("check_artifact_conflict", input.versionId);
  }

  if (input.versionId.startsWith(CHECK_ARTIFACT_PREFIX) && previousProposal === undefined && checkArtifactCount(state) >= MAX_CHECK_ARTIFACTS) {
    return failure("check_artifact_capacity", "check artifact history is full; no silent eviction");
  }

  if (input.parentVersionId !== undefined) {
    const parent = state.assets.find(asset => asset.versionId === input.parentVersionId);
    if (parent === undefined || !isCheckAssetAvailable(state, parent) || parent.scope !== input.scope || parent.kind !== input.kind) {
      return failure("check_artifact_parent_invalid", input.parentVersionId);
    }
  }

  const base = { issuedAt: input.issuedAt };
  const commands: readonly BoardCommand[] = [
    { ...base, type: "submit_proposal", commandId: `${proposal.proposalId}:submit`, proposal },
    { ...base, type: "quarantine", commandId: `${proposal.proposalId}:quarantine`, proposalId: proposal.proposalId },
    { ...base, type: "start_evaluation", commandId: `${proposal.proposalId}:evaluate`, proposalId: proposal.proposalId },
    { ...base, type: "commit_asset", commandId: `${proposal.proposalId}:commit`, proposalId: proposal.proposalId,
      versionId: input.versionId, schemaVersion: 1, content: input.content,
      ...(input.parentVersionId === undefined ? {} : { parentVersionId: input.parentVersionId }) },
  ];

  for (const command of commands) {
    const applied = await store.apply(command);
    if (!applied.ok) return failure(applied.reason, applied.detail);
  }

  return { ok: true, versionId: input.versionId, idempotent: false };
}

/** The Board log remains authoritative; callers decode their own namespaced content once. */
export async function readCheckArtifacts(boardRoot: string): Promise<{ readonly ok: true; readonly state: BoardState } | CheckBoardFailure> {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return failure(loaded.reason, loaded.detail);

  if (checkArtifactCount(loaded.state) > MAX_CHECK_ARTIFACTS) return failure("check_artifact_capacity", "check artifact history exceeds its bound");

  const corrupt = loaded.state.assets.find(asset => checkArtifactPrefix(asset.versionId) !== undefined
    && !isCheckAssetIntact(loaded.state, asset));
  if (corrupt !== undefined) return failure("check_artifact_corrupt", corrupt.versionId);

  return { ok: true, state: loaded.state };
}

/** A persisted artifact is usable data, never proof of activation or of independent verification. */
export function isCheckAssetAvailable(state: BoardState, asset: LearningAssetVersion): boolean {
  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  return isCheckAssetIntact(state, asset) && proposal !== undefined && proposal.lifecycle === "evaluating"
    && !isWithdrawn(state, asset.versionId, proposal.proposalId);
}

/** Integrity differs from availability: withdrawing intact history must not erase adverse feedback silently. */
function isCheckAssetIntact(state: BoardState, asset: LearningAssetVersion): boolean {
  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  return typeof asset.versionId === "string" && checkArtifactPrefix(asset.versionId) !== undefined
    && asset.schemaVersion === 1 && serializableContent(asset.content)
    && (asset.kind === "verification_recipe" || asset.kind === "workflow")
    && contentHashOf(asset.content) === asset.contentHash && proposal !== undefined
    && proposal.proposalId === proposalIdOf(asset.versionId) && proposal.domain === "verifier"
    && proposal.scope === asset.scope && proposal.assetKind === asset.kind && proposal.source === asset.source
    && proposal.candidateRef === `${asset.versionId}#${contentHashOf({ content: asset.content, parentVersionId: asset.parentVersionId })}`
    && Array.isArray(proposal.requestedAuthorities) && proposal.requestedAuthorities.length === 0
    && (asset.parentVersionId === undefined || (typeof asset.parentVersionId === "string"
      && checkArtifactPrefix(asset.parentVersionId) === checkArtifactPrefix(asset.versionId) && asset.parentVersionId !== asset.versionId));
}

function proposalOf(input: CheckArtifactInput): ProposalDraft {
  return { proposalId: proposalIdOf(input.versionId), domain: "verifier", scope: input.scope, assetKind: input.kind,
    // Bind the pending proposal to the exact payload too: command replay alone does not compare generic payloads.
    candidateRef: `${input.versionId}#${contentHashOf({ content: input.content, parentVersionId: input.parentVersionId })}`,
    hypothesis: input.hypothesis, observationRefs: input.sourceRefs, source: input.source,
    risk: "low", requiredVerifiers: [], requestedAuthorities: [] };
}

function proposalIdOf(versionId: string): string { return `${checkArtifactPrefix(versionId)}proposal:${versionId}`; }

/** v1 recipes and v2 executable checkers share the Board writer, with separate content decoders. */
function checkArtifactPrefix(versionId: string): string | undefined {
  return versionId.startsWith(CHECK_ARTIFACT_PREFIX) ? CHECK_ARTIFACT_PREFIX
    : versionId.startsWith(CHECKER_ARTIFACT_PREFIX) ? CHECKER_ARTIFACT_PREFIX : undefined;
}

function isWithdrawn(state: BoardState, versionId: string, proposalId: string): boolean {
  return state.tombstones.some(item => (item.entityType === "asset" && item.entityId === versionId)
    || (item.entityType === "proposal" && item.entityId === proposalId));
}

function checkArtifactCount(state: BoardState): number {
  // Count pending admissions as well, so repeated partial writes cannot reserve unbounded history.
  return state.proposals.filter(item => item.proposalId.startsWith(`${CHECK_ARTIFACT_PREFIX}proposal:`)).length;
}

function validInput(input: CheckArtifactInput): boolean {
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
  return text(input.versionId, 256) && checkArtifactPrefix(input.versionId) !== undefined
    && (input.kind === "verification_recipe" || input.kind === "workflow") && text(input.scope, 512)
    && (input.source === "user_explicit" || input.source === "inferred")
    && isIso8601(input.issuedAt) && text(input.hypothesis, 2048)
    && Array.isArray(input.sourceRefs) && input.sourceRefs.length <= 64 && input.sourceRefs.every(ref => text(ref, 512))
    && (input.parentVersionId === undefined || (text(input.parentVersionId, 256)
      && checkArtifactPrefix(input.parentVersionId) === checkArtifactPrefix(input.versionId) && input.parentVersionId !== input.versionId));
}

function serializableContent(content: unknown): boolean {
  try {
    const json = JSON.stringify(content);
    return json !== undefined && contentHashOf(JSON.parse(json) as unknown) === contentHashOf(content);
  } catch {
    // Serialization fails before any command; reject cyclic or unsupported payloads without a partial write.
    return false;
  }
}
