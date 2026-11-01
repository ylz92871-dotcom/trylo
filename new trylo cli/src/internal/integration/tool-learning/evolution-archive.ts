import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { ToolEvolutionArchive, ToolEvolutionArtifact } from "./evolution-runtime.js";
import { decodeToolEvolutionArtifact, toolEvolutionVersionId } from "../../learning/domains/tool/evolution/artifact.js";
import { candidateFromBoard } from "./evolution-reader.js";
import type { FileBoardStoreOptions } from "../../adapters/learning-store/file-event-store.js";

export type ToolJobAdmission = { readonly jobId: string; readonly attempt: number };
export type ToolEvolutionArchiveOptions = FileBoardStoreOptions & { readonly jobAdmission?: ToolJobAdmission };

export function createToolEvolutionArchive(boardRoot: string, options: ToolEvolutionArchiveOptions = {}): ToolEvolutionArchive {
  return {
    async save(artifact) {
      const decoded = decodeToolEvolutionArtifact(artifact);
      if (decoded === undefined) return { ok: false, code: "invalid_artifact", message: "candidate artifact has no complete, bound verification" };
      const versionId = toolEvolutionVersionId(decoded);
      const proposalId = `proposal_${versionId}`;
      const result = await withBoardWriter(boardRoot, async store => {
        const loaded = await store.load();
        if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };
        const admission = options.jobAdmission;
        if (admission !== undefined) {
          const job = loaded.state.jobs.find(item => item.jobId === admission.jobId);
          if (job?.state !== "running" || job.domain !== "tool" || job.attempt !== admission.attempt || job.scope !== decoded.request.scope
            || decoded.request.requestId !== `${job.jobId}:${job.attempt}`) return { ok: false as const, code: "job_not_running", message: "the job no longer owns this candidate write" };
        }
        const prior = decoded.request.prior;
        if (prior !== undefined) {
          const parent = candidateFromBoard(loaded.state, prior.versionId);
          if (!parent.ok) return parent;
          if (parent.artifact.request.scope !== decoded.request.scope || parent.artifact.candidate.source !== prior.source) {
            return { ok: false as const, code: "parent_binding_mismatch", message: "improvement must use the exact archived source in the same scope" };
          }
        }
        // Recovery validates the immutable asset before reusing a committed version.
        if (loaded.state.assets.some(asset => asset.versionId === versionId)) {
          const found = candidateFromBoard(loaded.state, versionId);
          return found.ok ? { ok: true as const, proposalId, versionId } : found;
        }
        for (const command of archiveCommands(decoded, proposalId, versionId)) {
          const applied = await store.apply(command);
          if (!applied.ok) return { ok: false as const, code: applied.reason, message: applied.detail };
        }
        return { ok: true as const, proposalId, versionId };
      }, options);
      return "reason" in result ? { ok: false, code: result.reason, message: result.detail } : result;
    },
  };
}

function archiveCommands(artifact: ToolEvolutionArtifact, proposalId: string, versionId: string): readonly BoardCommand[] {
  const issuedAt = artifact.generatedAt;
  const commandId = (step: string) => `${versionId}:${step}`;
  return [
    { type: "submit_proposal", commandId: commandId("submit"), issuedAt, proposal: {
      proposalId, domain: "tool", scope: artifact.request.scope, assetKind: "tool_package", candidateRef: versionId,
      hypothesis: artifact.request.capability, observationRefs: artifact.request.evidence.map(sample => sample.sampleId),
      risk: "high", requiredVerifiers: ["tool_validation_pipeline"], requestedAuthorities: ["modify", "activate"], source: "inferred",
      ...(artifact.request.prior === undefined ? {} : { baseVersionId: artifact.request.prior.versionId }),
    } },
    { type: "quarantine", commandId: commandId("quarantine"), issuedAt, proposalId },
    { type: "start_evaluation", commandId: commandId("evaluate"), issuedAt, proposalId },
    { type: "commit_asset", commandId: commandId("commit"), issuedAt, versionId, proposalId, schemaVersion: 1,
      ...(artifact.request.prior === undefined ? {} : { parentVersionId: artifact.request.prior.versionId }),
      content: { type: "tool_evolution_candidate", ...artifact } },
  ];
}

/** Candidate inventory is a projection of Board assets, not a second catalog or active pointer. */
export async function listToolEvolutionCandidates(boardRoot: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return loaded;
  return { ok: true as const, candidates: loaded.state.assets.filter(asset => {
    const content = asset.content;
    return asset.kind === "tool_package" && typeof content === "object" && content !== null && "type" in content && content.type === "tool_evolution_candidate";
  }).map(asset => ({ versionId: asset.versionId, scope: asset.scope, createdAt: asset.createdAt, contentHash: asset.contentHash, candidate: asset.content })) };
}
