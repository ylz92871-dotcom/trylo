import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import type { VerificationAuthorityReader } from "../../learning/verification-authority/contracts.js";
import type { ApprovalConsumptionPort, ApprovalGrantRef } from "../../ports/approval-consumption.js";
import { pipelineFailure } from "../../integration/tool-learning/pipeline-assets.js";
import { productionFromBoard } from "../../integration/tool-learning/production-assets.js";
import { activeProductionFromBoard, verifiedProductionFromBoard } from "../../integration/tool-learning/production-reader.js";

type Selection = { readonly boardRoot: string; readonly versionId: string; readonly workspaceId: string; readonly authority: VerificationAuthorityReader };

export async function reviewToolProductionFromBoard(state: BoardState, input: Selection) {
  const selected = await verifiedProductionFromBoard(state, input.versionId, input.workspaceId, input.authority);
  if (!selected.ok) return selected;
  const current = state.activations.find(item => item.scope === toolProductionScope(selected.plan) && item.assetKind === "tool_package");
  const coordinates = current === undefined ? null : { versionId: current.versionId, generation: current.generation, pointer: current.pointer };
  const reviewId = `production-review_v1_${contentHashOf({ versionId: input.versionId, workspaceId: input.workspaceId,
    receiptId: selected.receipt.receiptId, lifecycle: selected.lifecycle, current: coordinates })}`;
  return { ...selected, reviewId, current: coordinates };
}

export async function reviewToolProductionActivation(input: Selection) {
  const loaded = await createBoardReader(input.boardRoot).load();
  return loaded.ok ? reviewToolProductionFromBoard(loaded.state, input) : pipelineFailure(loaded.reason, loaded.detail);
}

/** Explicit command composition consumes Permission authority before Board changes; learning cannot call this. */
export async function activateToolProduction(input: Selection & { readonly reviewId: string; readonly permission: ApprovalConsumptionPort;
  readonly token: ApprovalGrantRef; readonly issuedAt: string }) {
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const reviewed = await reviewToolProductionFromBoard(loaded.state, input);
    if (!reviewed.ok) return reviewed;
    if (reviewed.reviewId !== input.reviewId) return pipelineFailure("production_review_stale", "re-review the current receipt, lifecycle and activation generation");
    if (reviewed.lifecycle === "active") return pipelineFailure("production_already_active", "no new activation is needed");
    if (!["evaluating", "shadow", "awaiting_approval", "suspended"].includes(reviewed.lifecycle)) return pipelineFailure("production_lifecycle_mismatch", "tool is not awaiting activation");
    const grant = await input.permission.consume({ token: input.token, action: "activate", candidateId: input.reviewId,
      packageVersionId: input.versionId, scope: toolProductionScope(reviewed.plan), now: input.issuedAt });
    if (!grant.ok) return grant;
    const prefix = `production-activate:${grant.value.grantId}`, approvalId = `production-approval:${input.versionId}`;
    if (reviewed.lifecycle === "suspended") {
      const approval = loaded.state.approvals.find(item => item.approvalId === approvalId && item.proposalId === reviewed.proposalId && item.action === "activate");
      if (reviewed.current?.versionId !== input.versionId || reviewed.current.pointer !== "suspended" || approval?.status !== "granted") {
        return pipelineFailure("production_approval_mismatch", "only the currently suspended, previously approved version can resume");
      }
      const resumed = await store.apply({ type: "resume", commandId: `${prefix}:resume`, issuedAt: input.issuedAt,
        proposalId: reviewed.proposalId, expectedGeneration: reviewed.current.generation });
      return resumed.ok ? activeProductionFromBoard(resumed.state, input.versionId, input.workspaceId, input.authority) : pipelineFailure(resumed.reason, resumed.detail);
    }
    // A crash may retain a prefix. A new explicit, freshly reviewed grant may finish it; a consumed grant cannot replay.
    const commands: BoardCommand[] = [];
    const base = { issuedAt: input.issuedAt, proposalId: reviewed.proposalId };
    if (reviewed.lifecycle === "evaluating") commands.push({ ...base, type: "enter_shadow", commandId: `${prefix}:shadow`, versionId: input.versionId });
    if (reviewed.lifecycle !== "awaiting_approval") commands.push({ ...base, type: "request_approval", commandId: `${prefix}:request`, approvalId, action: "activate" });
    const approval = loaded.state.approvals.find(item => item.approvalId === approvalId);
    if (approval !== undefined && (approval.proposalId !== reviewed.proposalId || approval.action !== "activate" || !["pending", "granted"].includes(approval.status))) {
      return pipelineFailure("production_approval_mismatch", "activation approval does not match this package");
    }
    if (approval?.status !== "granted") commands.push({ type: "record_approval_decision", commandId: `${prefix}:decision`, issuedAt: input.issuedAt, approvalId, status: "granted" });
    for (const command of commands) {
      const applied = await store.apply(command);
      if (!applied.ok) return pipelineFailure(applied.reason, applied.detail);
    }
    const ready = await store.load();
    if (!ready.ok) return pipelineFailure(ready.reason, ready.detail);
    const pointer = ready.state.activations.find(item => item.scope === toolProductionScope(reviewed.plan) && item.assetKind === "tool_package");
    const applied = await store.apply({ ...base, type: "activate", commandId: `${prefix}:activate`, versionId: input.versionId, expectedGeneration: pointer?.generation ?? 0 });
    if (!applied.ok) return pipelineFailure(applied.reason, applied.detail);
    return activeProductionFromBoard(applied.state, input.versionId, input.workspaceId, input.authority);
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

export async function stopToolProduction(input: Selection & { readonly action: "suspend" | "withdraw" | "rollback"; readonly commandId: string; readonly issuedAt: string }) {
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const selected = productionFromBoard(loaded.state, input.versionId, input.workspaceId);
    if (!selected.ok) return selected;
    const base = { proposalId: selected.proposalId, issuedAt: input.issuedAt };
    if (input.action === "withdraw" && ["evaluating", "shadow", "awaiting_approval"].includes(selected.lifecycle)) {
      const applied = await store.apply({ ...base, type: "reject", commandId: input.commandId, reason: "user_requested_production_withdrawal" });
      return applied.ok ? { ok: true as const, state: "withdrawn" } : pipelineFailure(applied.reason, applied.detail);
    }
    const current = loaded.state.activations.find(item => item.scope === toolProductionScope(selected.plan) && item.assetKind === "tool_package");
    if (current?.versionId !== input.versionId) return pipelineFailure("production_not_current", "this version no longer owns the tool slot");
    if (input.action === "rollback" && current.previousVersionId !== undefined) {
      const previous = await verifiedProductionFromBoard(loaded.state, current.previousVersionId, input.workspaceId, input.authority);
      if (!previous.ok) return previous;
      const approval = loaded.state.approvals.find(item => item.proposalId === previous.proposalId && item.action === "activate");
      if (previous.lifecycle !== "active" || toolProductionScope(previous.plan) !== current.scope || approval?.status !== "granted") {
        return pipelineFailure("production_rollback_unavailable", "predecessor is no longer approved and available");
      }
    }
    if (selected.lifecycle === "active") {
      const suspended = await store.apply({ ...base, type: "suspend", commandId: `${input.commandId}:suspend`, breakerReason: "user_requested_stop" });
      if (!suspended.ok) return pipelineFailure(suspended.reason, suspended.detail);
    } else if (selected.lifecycle !== "suspended") return pipelineFailure("production_lifecycle_mismatch", "tool cannot be stopped from this state");
    if (input.action !== "suspend") {
      const command: BoardCommand = input.action === "rollback" ? { ...base, type: "rollback", commandId: `${input.commandId}:rollback`, reason: "user_requested_rollback" }
        : { ...base, type: "retire", commandId: `${input.commandId}:retire` };
      const applied = await store.apply(command);
      if (!applied.ok) return pipelineFailure(applied.reason, applied.detail);
    }
    return { ok: true as const, versionId: input.versionId, state: input.action === "withdraw" ? "withdrawn" : input.action === "rollback" ? "rolled_back" : "suspended" };
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}
