import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolJobAdmission } from "./evolution-archive.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";

export async function readNpmLearningArtifact(boardRoot: string, versionId: string, scope: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const asset = loaded.state.assets.find(item => item.versionId === versionId);
  if (asset === undefined) return { ok: true as const, content: undefined };
  return asset.scope === scope && asset.kind === "workflow" && asset.contentHash === contentHashOf(asset.content) && assetAvailable(loaded.state, asset)
    ? { ok: true as const, content: asset.content } : pipelineFailure("npm_learning_artifact_unavailable", versionId);
}

/** Model output cannot commit after its Board claim has been cancelled or superseded. */
export async function saveNpmLearningArtifact(input: { readonly boardRoot: string; readonly scope: string; readonly admission: ToolJobAdmission;
  readonly versionId: string; readonly content: unknown; readonly issuedAt: string }) {
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const job = loaded.state.jobs.find(row => row.jobId === input.admission.jobId);
    if (job?.state !== "running" || job.attempt !== input.admission.attempt || job.scope !== input.scope || job.domain !== "tool") {
      return pipelineFailure("stale_job_result", input.admission.jobId);
    }

    return savePipelineAsset(store, { versionId: input.versionId, scope: input.scope, content: input.content,
      kind: "workflow", source: "inferred", issuedAt: input.issuedAt });
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}
