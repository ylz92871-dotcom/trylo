import { createBoardReader, withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import { stat } from "node:fs/promises";
import type { BoardCommand } from "../../../../../control/commands.js";
import type { LearningAssetVersion } from "../../../../../control/contracts.js";
import type { BoardState } from "../../../../../control/state.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { learnReadStrategy, parseReadStrategyPolicy, type ReadStrategyLearningRequest } from "../domain/index.js";

const VERSION_PREFIX = "tool-read-policy:";

function contentPolicyOf(asset: LearningAssetVersion) {
  return typeof asset.content === "string" ? parseReadStrategyPolicy(asset.content) : undefined;
}

export function readStrategyPolicyOf(asset: LearningAssetVersion | undefined) {
  if (asset === undefined || asset.kind !== "routing_policy" || asset.schemaVersion !== 2
    || !asset.versionId.startsWith(VERSION_PREFIX) || typeof asset.content !== "string"
    || asset.contentHash !== contentHashOf(asset.content)) return undefined;
  const policy = contentPolicyOf(asset);
  return policy?.scope === asset.scope ? policy : undefined;
}

export async function readStrategyBoard(root: string): Promise<BoardState> {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("routing_board:not_directory");
  } catch (error) {
    // An absent learning directory is an empty archive; other IO faults are unavailable.
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const read = await createBoardReader(root).load();
  if (!read.ok) throw new Error(`routing_board:${read.reason}`);

  return read.state;
}

function ownedCommit(state: BoardState, asset: LearningAssetVersion, scope: string): boolean {
  return asset.kind === "routing_policy" && asset.scope === scope && asset.versionId.startsWith(VERSION_PREFIX)
    && !state.tombstones.some(item => item.entityType === "asset" && item.entityId === asset.versionId
      || item.entityType === "proposal" && item.entityId === asset.createdFromProposalId)
    && state.proposals.some(proposal => proposal.proposalId === asset.createdFromProposalId
      && proposal.domain === "tool" && proposal.scope === scope && proposal.assetKind === asset.kind && proposal.lifecycle === "evaluating");
}

/** Only tool-owned commits are eligible. The legacy kind remains a shared persisted vocabulary. */
export function latestReadStrategyAsset(state: BoardState, scope: string): LearningAssetVersion | undefined {
  return [...state.assets].reverse().find(asset => ownedCommit(state, asset, scope));
}

export async function publishReadStrategy(root: string, request: ReadStrategyLearningRequest, canWrite: () => boolean = () => true) {
  if (!canWrite()) return { status: "disabled" as const, reason: "collection_disabled", consumed: { observations: 0 } };

  const written = await withBoardWriter(root, async store => {
    if (!canWrite()) return { status: "disabled" as const, reason: "collection_disabled", consumed: { observations: 0 } };

    const loaded = await store.load();
    if (!loaded.ok) return { status: "disabled" as const, reason: loaded.reason, consumed: { observations: 0 } };

    const previous = latestReadStrategyAsset(loaded.state, request.scope);
    // The stable identity also detects a corrupt payload that can no longer expose its request ID.
    const versionId = `${VERSION_PREFIX}${contentHashOf([request.scope, request.requestId]).slice(0, 32)}`;
    const existing = loaded.state.assets.find(asset => asset.versionId === versionId
      || asset.kind === "routing_policy" && asset.scope === request.scope && contentPolicyOf(asset)?.requestId === request.requestId);
    if (existing !== undefined) {
      const policy = readStrategyPolicyOf(existing);
      if (!ownedCommit(loaded.state, existing, request.scope) || policy === undefined || policy.requestId !== request.requestId) {
        return { status: "disabled" as const, reason: "read_strategy_request_conflict", consumed: { observations: 0 } };
      }
      return { status: "learned" as const, reason: "request_already_committed", policy, versionId: existing.versionId,
        consumed: { observations: 0 } };
    }

    const result = learnReadStrategy(loaded.state, request);
    if (result.policy === undefined) return result;

    // Stable across a partially appended proposal/evaluation sequence; same request resumes it.
    const proposalId = `proposal:${versionId}`;
    const base = { issuedAt: request.issuedAt, proposalId };
    const commands: BoardCommand[] = [
      { type: "submit_proposal", commandId: `${versionId}:submit`, issuedAt: request.issuedAt,
        proposal: { proposalId, domain: "tool", assetKind: "routing_policy", scope: request.scope,
          candidateRef: versionId, hypothesis: "Conditioned comparison of externally checked existing read strategies",
          observationRefs: result.policy.rules.flatMap(rule => rule.feedbackIds), risk: "low", source: "inferred",
          requestedAuthorities: [], requiredVerifiers: [], ...(previous === undefined ? {} : { baseVersionId: previous.versionId }) } },
      { ...base, type: "quarantine", commandId: `${versionId}:quarantine` },
      { ...base, type: "start_evaluation", commandId: `${versionId}:evaluate` },
      { ...base, type: "commit_asset", commandId: `${versionId}:commit`, versionId, schemaVersion: 2,
        content: JSON.stringify(result.policy), ...(previous === undefined ? {} : { parentVersionId: previous.versionId }) },
    ];

    for (const command of commands) {
      if (!canWrite()) return { status: "disabled" as const, reason: "collection_disabled", consumed: result.consumed };
      const applied = await store.apply(command);
      if (!applied.ok) return { status: "disabled" as const, reason: applied.reason, consumed: result.consumed };
    }

    return { ...result, versionId };
  }, { commandGuard: canWrite });

  return "status" in written ? written : { status: "disabled" as const, reason: written.reason, consumed: { observations: 0 } };
}
