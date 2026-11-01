import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { VerificationAuthorityReader } from "../../learning/verification-authority/contracts.js";
import { toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import { admitToolEvidence } from "../contract/gateway.js";
import { productionFromBoard } from "./production-assets.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { verifiedProductionFromBoard } from "./production-reader.js";

/** Only an opaque receipt crosses this boundary; archived checker output cannot issue authority. */
export async function admitToolProductionVerification(input: { readonly boardRoot: string; readonly versionId: string; readonly workspaceId: string;
  readonly authority: VerificationAuthorityReader; readonly receiptId: string; readonly issuedAt: string; readonly jobId?: string }) {
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const selected = productionFromBoard(loaded.state, input.versionId, input.workspaceId);
    if (!selected.ok) return selected;
    if (selected.lifecycle !== "evaluating") return pipelineFailure("production_lifecycle_mismatch", "verification admission requires evaluating state");
    if (input.jobId !== undefined) {
      const job = loaded.state.jobs.find(item => item.jobId === input.jobId);
      if (job?.state !== "running" || job.attempt !== 1 || job.observationId !== selected.proposalId || job.scope !== toolProductionScope(selected.plan)) {
        return pipelineFailure("production_check_claim_lost", "late verification cannot admit evidence after its job was closed");
      }
    }
    const mapped = await admitToolEvidence(input.authority, { kind: "submit_evidence", evidenceId: `production-evidence:${input.receiptId}`, summary: "Real confined production checks for the frozen package" },
      { commandId: `production-admit:${input.receiptId}`, issuedAt: input.issuedAt, proposalId: selected.proposalId,
        dataVersion: input.versionId, packageVersionId: input.versionId, scope: toolProductionScope(selected.plan), receiptRef: input.receiptId });
    if (!mapped.ok) return pipelineFailure(mapped.reason, mapped.detail);
    // Pin checker identity before writing any promotion evidence. Gateway validates subject/version/scope.
    const prospective = { ...loaded.state, evidence: [...loaded.state.evidence, ...mapped.value.map(command => command.evidence)] };
    const trusted = await verifiedProductionFromBoard(prospective, input.versionId, input.workspaceId, input.authority);
    if (!trusted.ok || trusted.receipt.receiptId !== input.receiptId) return trusted.ok ? pipelineFailure("production_receipt_mismatch", "a different receipt was selected") : trusted;
    for (const command of mapped.value) {
      const applied = await store.apply(command);
      if (!applied.ok) return pipelineFailure(applied.reason, applied.detail);
    }
    return { ok: true as const, versionId: input.versionId, receiptId: input.receiptId, state: "verified_pending_activation" as const };
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}
