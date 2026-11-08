import type { BoardState } from "../../../learning/control/state.js";
import type { LearningAssetVersion, LearningDomain } from "../../../learning/control/contracts.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import type { ContentMaterialBatch, ContentSubsystem } from "../../../learning/central/content/material-contract.js";
import { readContentRecords } from "../records.js";

/** Exact identity map shared by retrieval and actual-adoption readers. Related inputs are not relabelled as outputs. */
export interface ContentArtifactMapping {
  readonly ref: string;
  readonly version: string;
  readonly domain: LearningDomain;
  readonly subsystem: ContentSubsystem;
  readonly issueIds: readonly string[];
  readonly topicIds: readonly string[];
  readonly contentFactIds: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly originalScope?: string;
}

export function contentSubsystem(domain: LearningDomain): ContentSubsystem {
  return domain === "prompt" ? "method" : domain === "tool" || domain === "workflow" || domain === "skill" ? domain : "collaboration";
}

function assetDomain(asset: LearningAssetVersion, board: BoardState): LearningDomain {
  const proposal = board.proposals.find(row => row.proposalId === asset.createdFromProposalId);
  return proposal?.domain ?? (asset.kind === "prompt_patch" ? "prompt" : asset.kind === "workflow" ? "workflow"
    : asset.kind === "skill" ? "skill" : asset.kind === "tool_binding" || asset.kind === "tool_package" ? "tool" : "collaboration");
}

/** Source-owned assets and immutable content products; no association is inferred merely from a shared scope. */
export function mapBoardContentArtifacts(board: BoardState, scope: string): readonly ContentArtifactMapping[] {
  const content = readContentRecords(board.rewardV2Facts ?? [], scope, board.sequence);
  const products: ContentArtifactMapping[] = content.map(record => ({ ref: record.factId, version: record.output.processId,
    domain: record.packet.domain, subsystem: contentSubsystem(record.packet.domain),
    issueIds: record.packet.focus === undefined ? [] : [record.packet.focus.issueId],
    topicIds: record.handoff.kind === "new_topic" ? [record.handoff.topic.topicId] : [], contentFactIds: [record.factId],
    sourceRefs: [record.factId, ...record.packet.records.map(row => row.ref)] }));

  for (const asset of board.assets.filter(row => row.kind !== "user_rule")) {
    const proposal = board.proposals.find(row => row.proposalId === asset.createdFromProposalId);
    const addresses = new Set([asset.versionId, ...(asset.createdFromProposalId === undefined ? [] : [asset.createdFromProposalId]),
      ...(proposal === undefined ? [] : [proposal.candidateRef])]);
    const jobs = board.jobs.filter(job => job.scope === scope && job.coordination?.resultRefs?.some(ref => addresses.has(ref)));
    if (asset.scope !== scope && jobs.length === 0) continue;

    const contentFactIds = [...new Set(jobs.flatMap(job => job.coordination?.resultRefs ?? []).filter(ref => content.some(record => record.factId === ref)))];
    const domain = assetDomain(asset, board);

    products.push({ ref: asset.versionId, version: asset.versionId, domain, subsystem: contentSubsystem(domain), originalScope: asset.scope,
      issueIds: [...new Set(jobs.flatMap(job => job.coordination === undefined ? [] : [job.coordination.issueId]))],
      topicIds: content.filter(record => contentFactIds.includes(record.factId)).flatMap(record => record.handoff.kind === "new_topic" ? [record.handoff.topic.topicId] : []),
      contentFactIds, sourceRefs: [...new Set([asset.versionId, ...(proposal === undefined ? [] : [proposal.proposalId, proposal.candidateRef, ...proposal.observationRefs]),
        ...jobs.map(job => job.jobId), ...contentFactIds])] });
  }

  return products;
}

export const boardAssetContentRef = (asset: Pick<LearningAssetVersion, "versionId" | "contentHash" | "scope">): string =>
  `board-asset-content:${contentHashOf([asset.scope, asset.versionId, asset.contentHash])}`;
/** scope is the admitted projection scope; an asset's original scope is retained separately. */
export const boardAssetProjectionRunId = (asset: Pick<LearningAssetVersion, "scope" | "versionId">): string =>
  `board-asset-projection:${contentHashOf([asset.scope, asset.versionId])}`;

/** Preserve the complete original asset and real fielding receipts; activation alone is never an adoption receipt. */
export function boardArtifactMaterialBatch(board: BoardState, scope: string, mapping: ContentArtifactMapping): ContentMaterialBatch {
  const asset = board.assets.find(row => row.versionId === mapping.ref && row.versionId === mapping.version);
  if (asset === undefined || asset.kind === "user_rule" || contentHashOf(asset.content) !== asset.contentHash) throw new Error("content_asset_identity_invalid");

  const ref = boardAssetContentRef(asset), projectionRun = boardAssetProjectionRunId({ scope, versionId: asset.versionId });
  const content = canonicalJson(asset.content);
  const activations = board.activations.filter(row => row.versionId === asset.versionId && row.boardSequence <= board.sequence);
  const fieldings = board.fieldings.filter(row => row.versionId === asset.versionId);
  const uses = (board.toolUses ?? []).filter(row => row.versionId === asset.versionId);
  const exposures = (board.rewardExposures ?? []).filter(row => row.targets.some(target => target.id === mapping.ref && target.version === mapping.version));
  const evidence = board.evidence.filter(row => row.proposalId === asset.createdFromProposalId);
  const activationState = activations.length === 0 ? "not_active" : activations.some(row => row.pointer === "active" && !row.breaker?.open) ? "active" : "inactive";
  const receiptRef = `board-asset-receipts:${contentHashOf([scope, board.sequence, mapping.ref, mapping.version])}`;
  const receipt = canonicalJson({ role: "source_owned_activation_and_actual_adoption_records_not_learning_gain", originalScope: asset.scope,
    knownAtBoardSequence: board.sequence, assetVersionId: asset.versionId, contentHash: asset.contentHash, activationState,
    activations, fieldings, toolUses: uses, rewardExposures: exposures, evidence });
  const links = { issueIds: mapping.issueIds, topicIds: mapping.topicIds, artifactRefs: [{ id: mapping.ref, version: mapping.version }] };

  return {
    records: [{ ref, runId: projectionRun, sequence: 0, scope, origin: "model_proposal", text: content },
      { ref: receiptRef, runId: projectionRun, sequence: 1, scope, origin: "execution_result", text: receipt }], requirements: [],
    answers: [{ answerId: ref, question: `Original learned artifact ${asset.versionId}; its original natural question may be absent.`,
      requirement: "Use only within the artifact's original scope, declared conditions and retained support; no broader adequacy is certified.",
      answer: content.length <= 8192 ? content : `Complete original content is at ${ref}; read that source without treating this address as its answer.`,
      conditions: [canonicalJson({ originalScope: asset.scope, kind: asset.kind, source: asset.source, activationState,
        activationPointers: activations.map(row => ({ pointer: row.pointer, generation: row.generation, breaker: row.breaker ?? null })),
        verificationEvidenceRefs: evidence.map(row => row.evidenceId) }),
        "Applicability, exceptions and provenance remain in the original artifact; actual fielding is separate from task result and learning gain."],
      supportRefs: [ref, receiptRef], artifactRefs: links.artifactRefs }],
    materials: [{ id: ref, kind: "known_answer", subsystem: mapping.subsystem,
      context: canonicalJson({ source: "Board.assets.content", originalScope: asset.scope, versionId: asset.versionId,
        contentHash: asset.contentHash, createdAt: asset.createdAt, sourceRefs: mapping.sourceRefs, coordinateKind: "explicit_board_asset_projection" }),
      recordRefs: [ref, receiptRef], requirementIds: [], answerIds: [ref], links }],
  };
}
