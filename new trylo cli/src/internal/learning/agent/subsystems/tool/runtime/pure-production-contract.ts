import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isDigest } from "../domain/evolution/artifact.js";
import { isToolProductionVersion } from "../domain/evolution/production-plan.js";
import { keysAre, recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";

export type PureProductionContract = {
  readonly type: "tool_pure_production_regression_contract"; readonly schemaVersion: 1;
  readonly jobId: string; readonly attempt: number; readonly scope: string;
  readonly parent: { readonly versionId: string; readonly contentHash: string; readonly checksHash: string; readonly artifactVersionId: string };
  /** Absent on legacy anchors; only exact approved production corrections apply. */
  readonly revisionRefs?: readonly string[];
};

export function pureProductionContractVersion(jobId: string, attempt: number): string {
  return `pure-production-regression-contract_v1_${contentHashOf({ jobId, attempt })}`;
}

/** Generation receives only training. Its exact request identity links to this
 * host-owned immutable contract; no oracle is copied into model-facing data. */
export function pureProductionContractFromBoard(state: BoardState, requestId: string) {
  const match = /^(.*):([1-9]\d*)$/.exec(requestId);
  if (match === null) return { ok: true as const };

  const jobId = match[1]!, attempt = Number(match[2]);
  const asset = state.assets.find(row => row.versionId === pureProductionContractVersion(jobId, attempt));
  if (asset === undefined) return { ok: true as const };

  const raw = asset.content;
  if (!assetAvailable(state, asset) || asset.kind !== "workflow" || !recordOf(raw)
    || !keysAre(raw, ["type", "schemaVersion", "jobId", "attempt", "scope", "parent"], ["revisionRefs"])
    || raw.type !== "tool_pure_production_regression_contract" || raw.schemaVersion !== 1
    || raw.jobId !== jobId || raw.attempt !== attempt || raw.scope !== asset.scope || typeof raw.scope !== "string"
    || !recordOf(raw.parent) || !keysAre(raw.parent, ["versionId", "contentHash", "checksHash", "artifactVersionId"])
    || !isToolProductionVersion(raw.parent.versionId) || !isDigest(raw.parent.contentHash) || !isDigest(raw.parent.checksHash)
    || typeof raw.parent.artifactVersionId !== "string" || !/^tool-evolution(?:_v1)?_[a-f0-9]{64}$/.test(raw.parent.artifactVersionId)
    || (raw.revisionRefs !== undefined && (!Array.isArray(raw.revisionRefs) || raw.revisionRefs.length > 8
      || !raw.revisionRefs.every(ref => typeof ref === "string" && /^tool-contract-revision_v1_[a-f0-9]{64}$/.test(ref))
      || new Set(raw.revisionRefs).size !== raw.revisionRefs.length))) {
    return pipelineFailure("invalid_pure_production_contract", "the host-owned regression contract cannot be recovered");
  }

  const contract: PureProductionContract = { type: raw.type, schemaVersion: 1, jobId, attempt, scope: raw.scope,
    parent: { versionId: raw.parent.versionId, contentHash: raw.parent.contentHash, checksHash: raw.parent.checksHash, artifactVersionId: raw.parent.artifactVersionId },
    ...(raw.revisionRefs === undefined ? {} : { revisionRefs: raw.revisionRefs }) };

  return { ok: true as const, contract };
}
