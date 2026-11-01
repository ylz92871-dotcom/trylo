import type {
  ActivateCommand,
  CommitAssetCommand,
  EnterShadowCommand,
  RecordApprovalDecisionCommand,
  RecordEvidenceCommand,
} from "./commands.js";
import type { ActivationRecord, EvidenceBundle, LearningAssetVersion, LearningProposal } from "./contracts.js";
import { contentHashOf } from "./hash.js";
import type { ReduceResult } from "./result.js";
import { fail, nextSeq, succeed } from "./result.js";
import {
  findApproval,
  findAsset,
  findActivationByProposal,
  findEvidenceFor,
  findProposal,
  replaceById,
  type BoardState,
} from "./state.js";
import { expectedTo } from "./transitions.js";

export function applyRecordEvidence(
  state: BoardState,
  command: RecordEvidenceCommand,
): ReduceResult {
  const evidence = command.evidence;
  const proposal = findProposal(state, evidence.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", evidence.proposalId);
  }
  if (proposal.lifecycle !== "evaluating" && proposal.lifecycle !== "shadow") {
    return fail(state, "illegal_transition", `${proposal.lifecycle}->record_evidence`);
  }
  if (llmCritiqueClaimsPass(evidence.kinds, evidence.externalVerdict)) {
    return fail(state, "llm_critique_cannot_pass", evidence.evidenceId);
  }
  // WP-F / 外审 R2 §3.1：独立证据必须可回查到一条权威收据。
  // Board 保持纯函数（不持有 registry 端口），因此这里检查的是**可追溯性**：
  // 携带 external_verifier / user_feedback 权力的证据必须带 receipt 坐标，且
  // provenance 必须恰好指向同一条收据。结构漂亮的 EvidenceBundle 不再足够。
  if (!isTraceableIndependentEvidence(evidence)) {
    return fail(state, "unverifiable_evidence_provenance", evidence.evidenceId);
  }
  const sequence = nextSeq(state);
  return succeed(state, command.commandId, [
    {
      type: "evidence_recorded",
      sequence,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      evidence,
    },
  ], { evidence: [...state.evidence, evidence] });
}

export function applyCommitAsset(
  state: BoardState,
  command: CommitAssetCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }
  if (findAsset(state, command.versionId)) {
    return fail(state, "active_content_immutable", command.versionId);
  }
  const asset = buildAsset(command, proposal);
  const sequence = nextSeq(state);
  return succeed(state, command.commandId, [
    {
      type: "asset_committed",
      sequence,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      asset,
    },
  ], { assets: [...state.assets, asset] });
}

export function applyEnterShadow(
  state: BoardState,
  command: EnterShadowCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }
  if (expectedTo(proposal.lifecycle, "enter_shadow") !== "shadow") {
    return fail(state, "illegal_transition", `${proposal.lifecycle}->enter_shadow`);
  }
  const asset = findAsset(state, command.versionId);
  if (asset === undefined) {
    return fail(state, "asset_not_found", command.versionId);
  }
  if (asset.createdFromProposalId !== proposal.proposalId || asset.scope !== proposal.scope || asset.kind !== proposal.assetKind) {
    return fail(state, "illegal_transition", "shadow asset does not belong to this proposal");
  }
  if (!hasIndependentPass(state, proposal.proposalId)) {
    return fail(state, "external_pass_required", command.proposalId);
  }
  const existing = findActivationByProposal(state, proposal);
  return commitLifecycleAndPointer(state, command.commandId, command.issuedAt, proposal, "shadow", {
    activationId: existing?.activationId ?? `act:${proposal.scope}:${proposal.assetKind}`,
    scope: proposal.scope,
    assetKind: proposal.assetKind,
    pointer: "shadow",
    versionId: command.versionId,
    generation: (existing?.generation ?? 0) + 1,
    ...(existing === undefined || existing.versionId === command.versionId ? {} : { previousVersionId: existing.versionId }),
  });
}

export function applyActivate(
  state: BoardState,
  command: ActivateCommand,
): ReduceResult {
  const proposal = findProposal(state, command.proposalId);
  if (proposal === undefined) {
    return fail(state, "proposal_not_found", command.proposalId);
  }
  if (expectedTo(proposal.lifecycle, "activate") !== "active") {
    return fail(state, "illegal_transition", `${proposal.lifecycle}->activate`);
  }
  const asset = findAsset(state, command.versionId);
  if (asset === undefined) {
    return fail(state, "asset_not_found", command.versionId);
  }
  if (asset.createdFromProposalId !== proposal.proposalId || asset.scope !== proposal.scope || asset.kind !== proposal.assetKind) {
    return fail(state, "illegal_transition", "activation asset does not belong to this proposal");
  }
  const approvalGate = activationApprovalGate(state, proposal);
  if (approvalGate !== undefined) {
    return fail(state, approvalGate, command.proposalId);
  }
  const existing = findActivationByProposal(state, proposal);
  if (casMismatch(command.expectedGeneration, existing)) {
    return fail(state, "activation_cas_mismatch", String(existing?.generation ?? 0));
  }
  if (existing?.pointer === "active" && existing.versionId !== command.versionId) {
    return fail(state, "illegal_transition", "active pointer already set");
  }
  const previous =
    existing !== undefined && existing.versionId !== command.versionId
      ? { previousVersionId: existing.versionId }
      : existing?.previousVersionId === undefined ? {} : { previousVersionId: existing.previousVersionId };
  return commitLifecycleAndPointer(state, command.commandId, command.issuedAt, proposal, "active", {
    activationId: existing?.activationId ?? `act:${proposal.scope}:${proposal.assetKind}`,
    scope: proposal.scope,
    assetKind: proposal.assetKind,
    pointer: "active",
    versionId: command.versionId,
    generation: (existing?.generation ?? 0) + 1,
    ...previous,
  });
}

export function applyApprovalDecision(
  state: BoardState,
  command: RecordApprovalDecisionCommand,
): ReduceResult {
  const approval = findApproval(state, command.approvalId);
  if (approval === undefined) {
    return fail(state, "approval_not_found", command.approvalId);
  }
  if (approval.status !== "pending" && command.status !== "revoked") {
    return fail(state, "illegal_transition", `${approval.status}->${command.status}`);
  }
  const next = { ...approval, status: command.status };
  const sequence = nextSeq(state);
  const proposal = findProposal(state, approval.proposalId);
  const rejectProposal =
    command.status === "denied" &&
    proposal !== undefined &&
    expectedTo(proposal.lifecycle, "reject") === "rejected";
  const rejected = rejectProposal && proposal !== undefined
    ? { ...proposal, lifecycle: "rejected" as const }
    : undefined;
  const events = [
    {
      type: "approval_changed" as const,
      sequence,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      approval: next,
    },
    ...(rejected !== undefined && proposal !== undefined
      ? [
          {
            type: "proposal_transitioned" as const,
            sequence: sequence + 1,
            commandId: command.commandId,
            occurredAt: command.issuedAt,
            proposalId: proposal.proposalId,
            from: proposal.lifecycle,
            to: "rejected" as const,
          },
        ]
      : []),
  ];
  return succeed(state, command.commandId, events, {
    approvals: replaceById(
      state.approvals,
      (item) => item.approvalId === approval.approvalId,
      next,
    ),
    ...(rejected !== undefined
      ? {
          proposals: replaceById(
            state.proposals,
            (item) => item.proposalId === rejected.proposalId,
            rejected,
          ),
        }
      : {}),
  });
}

/**
 * 由调用方给出目标状态并写入激活指针。
 *
 * `boardSequence` 由本函数唯一 stamp（外审 R2 §4.7）：调用方传入的是
 * `UnstampedActivation`（显式没有该字段），不能再用 `0` 哨兵假装一个序号。
 * 旧实现让 `stale_sequence` 门对 `boardSequence === 0` 的 shadow 态失效。
 */
export type UnstampedActivation = Omit<ActivationRecord, "boardSequence">;

export function commitLifecycleAndPointer(
  state: BoardState,
  commandId: string,
  occurredAt: string,
  proposal: LearningProposal,
  to: LearningProposal["lifecycle"],
  activation: UnstampedActivation,
): ReduceResult {
  const nextProposal = { ...proposal, lifecycle: to };
  const seq = nextSeq(state);
  const stamped: ActivationRecord = { ...activation, boardSequence: seq + 1 };
  return succeed(state, commandId, [
    {
      type: "proposal_transitioned",
      sequence: seq,
      commandId,
      occurredAt,
      proposalId: proposal.proposalId,
      from: proposal.lifecycle,
      to,
    },
    {
      type: "activation_changed",
      sequence: seq + 1,
      commandId,
      occurredAt,
      activation: stamped,
    },
  ], {
    proposals: replaceById(
      state.proposals,
      (item) => item.proposalId === proposal.proposalId,
      nextProposal,
    ),
    activations: replaceById(
      state.activations,
      (item) => item.activationId === stamped.activationId,
      stamped,
    ),
  });
}

export function casMismatch(
  expected: number | undefined,
  existing: ActivationRecord | undefined,
): boolean {
  return expected !== undefined && existing !== undefined && existing.generation !== expected;
}

function buildAsset(
  command: CommitAssetCommand,
  proposal: LearningProposal,
): LearningAssetVersion {
  const asset: LearningAssetVersion = {
    versionId: command.versionId,
    kind: proposal.assetKind,
    schemaVersion: command.schemaVersion,
    content: command.content,
    contentHash: contentHashOf(command.content),
    source: proposal.source,
    scope: proposal.scope,
    createdAt: command.issuedAt,
    createdFromProposalId: proposal.proposalId,
  };
  if (command.parentVersionId === undefined) {
    return asset;
  }
  return { ...asset, parentVersionId: command.parentVersionId };
}

function llmCritiqueClaimsPass(
  kinds: ReadonlyArray<string>,
  verdict: string | undefined,
): boolean {
  const independent =
    kinds.includes("external_verifier") ||
    kinds.includes("user_feedback") ||
    kinds.includes("execution_fact");
  return kinds.includes("llm_critique") && verdict === "pass" && !independent;
}

function hasIndependentPass(state: BoardState, proposalId: string): boolean {
  return findEvidenceFor(state, proposalId).some(
    (bundle) =>
      bundle.externalVerdict === "pass" &&
      bundle.receipt !== undefined &&
      (bundle.kinds.includes("external_verifier") ||
        bundle.kinds.includes("user_feedback") ||
        bundle.kinds.includes("execution_fact")),
  );
}

/**
 * 独立证据的可追溯性门（WP-F §7 D3.5）。
 *
 * 只有 llm_critique / execution_fact 这类不携带独立裁决的证据可以没有收据；
 * 任何声称 external_verifier 或 user_feedback 的证据都必须同时给出收据坐标，
 * 且 `provenance` 必须是 `receipt:<receiptId>`——即这条证据的权威来源可被
 * 独立回查。这不是权威判定本身（判定在 gateway 读回 registry 时完成），
 * 而是保证「每次晋升都能被审计回查」的地板。
 */
function isTraceableIndependentEvidence(evidence: EvidenceBundle): boolean {
  const claimsIndependent =
    evidence.kinds.includes("external_verifier") ||
    evidence.kinds.includes("user_feedback") ||
    evidence.kinds.includes("execution_fact");
  if (!claimsIndependent) {
    return true;
  }
  if (evidence.receipt === undefined) {
    return false;
  }
  return evidence.provenance === `receipt:${evidence.receipt.receiptId}`;
}

function activationApprovalGate(
  state: BoardState,
  proposal: LearningProposal,
): "approval_required" | "approval_not_granted" | undefined {
  if (proposal.lifecycle !== "awaiting_approval") {
    return undefined;
  }
  const approval = state.approvals.find((item) => item.proposalId === proposal.proposalId);
  if (approval === undefined) {
    return "approval_required";
  }
  if (approval.status !== "granted") {
    return "approval_not_granted";
  }
  return undefined;
}
