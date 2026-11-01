import type { BoardState } from "../../learning/control/state.js";
import type { VerificationAuthorityReader } from "../../learning/verification-authority/contracts.js";
import { toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { productionFromBoard, toolProductionGenerator, toolProductionVerifier } from "./production-assets.js";

/** A traceable Board evidence shape is insufficient: every read resolves the trusted receipt. */
export async function verifiedProductionFromBoard(state: BoardState, versionId: string, workspaceId: string, authority: VerificationAuthorityReader) {
  const selected = productionFromBoard(state, versionId, workspaceId);
  if (!selected.ok) return selected;
  if (["rejected", "rolled_back", "retired"].includes(selected.lifecycle)) return pipelineFailure("production_unavailable", "production proposal is not available");
  const evidence = state.evidence.filter(item => item.proposalId === selected.proposalId && item.dataVersion === versionId
    && item.externalVerdict === "pass" && item.kinds.includes("external_verifier") && item.receipt !== undefined
    && item.provenance === `receipt:${item.receipt.receiptId}`).reverse();
  for (const item of evidence) {
    const coordinate = item.receipt;
    if (coordinate === undefined) continue;
    const verified = await authority.verify({ receiptId: coordinate.receiptId }, { domain: "agent_method", subjectKind: "tool_package_version",
      subjectId: versionId, subjectVersion: versionId, scope: toolProductionScope(selected.plan) });
    if (!verified.ok) return pipelineFailure(verified.code, verified.message);
    const receipt = verified.receipt;
    if (receipt.verdict !== "pass" || receipt.verifierId !== toolProductionVerifier(selected.plan) || receipt.generatorId !== toolProductionGenerator(selected.plan)
      || receipt.checksDigest !== coordinate.checksDigest || receipt.sourceDigest !== coordinate.sourceDigest) {
      return pipelineFailure("production_receipt_mismatch", "receipt does not bind the trusted production checker and Board evidence");
    }
    return { ...selected, receipt };
  }
  return pipelineFailure("production_verification_required", "no independent production verification was admitted");
}

export async function readActiveProductionTool(input: { readonly boardRoot: string; readonly versionId: string; readonly workspaceId: string; readonly authority: VerificationAuthorityReader }) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  return activeProductionFromBoard(loaded.state, input.versionId, input.workspaceId, input.authority);
}

export async function activeProductionFromBoard(state: BoardState, versionId: string, workspaceId: string, authority: VerificationAuthorityReader) {
  const selected = await verifiedProductionFromBoard(state, versionId, workspaceId, authority);
  if (!selected.ok) return selected;
  const pointer = state.activations.find(item => item.scope === toolProductionScope(selected.plan) && item.assetKind === "tool_package");
  const approval = state.approvals.find(item => item.approvalId === `production-approval:${versionId}` && item.proposalId === selected.proposalId && item.action === "activate");
  if (selected.lifecycle !== "active" || pointer?.versionId !== versionId || pointer.pointer !== "active" || pointer.breaker?.open === true
    || approval?.status !== "granted") return pipelineFailure("production_not_active", "tool has no current active pointer and activation approval");
  return { ...selected, generation: pointer.generation };
}
