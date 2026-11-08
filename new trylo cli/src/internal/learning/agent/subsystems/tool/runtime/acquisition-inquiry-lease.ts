import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { contentHashOf } from "../../../../control/hash.js";
import { recordOf, keysAre, textOf } from "../domain/evolution/parse.js";
import { ACQUISITION_START_LEASE_MS } from "../domain/evolution/acquisition-lease.js";
import { acquisitionInquirySpecId } from "../domain/evolution/acquisition-inquiry.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";

export function inquiryLeaseFromBoard(state: BoardState, jobId: string, attempt: number, scope: string) {
  let expiresAt: string | undefined, count = 0;

  for (const asset of state.assets) {
    const raw = asset.content;
    if (!recordOf(raw) || raw.type !== "tool_acquisition_inquiry_lease" || raw.jobId !== jobId || raw.attempt !== attempt) continue;

    if (++count > 16 || !keysAre(raw, ["type", "schemaVersion", "jobId", "attempt", "scope", "specVersionId", "startedAt", "expiresAt"])
      || raw.schemaVersion !== 1 || raw.scope !== scope || raw.specVersionId !== acquisitionInquirySpecId(jobId, attempt)
      || !textOf(raw.startedAt, 64) || !textOf(raw.expiresAt, 64) || !Number.isFinite(Date.parse(raw.startedAt))
      || Date.parse(raw.expiresAt) !== Date.parse(raw.startedAt) + ACQUISITION_START_LEASE_MS
      || !assetAvailable(state, asset) || asset.kind !== "workflow" || asset.source !== "inferred" || asset.scope !== scope
      || asset.versionId !== `acquisition-inquiry-lease_v1_${contentHashOf(raw)}`) return pipelineFailure("invalid_inquiry_lease", jobId);

    expiresAt = raw.expiresAt;
  }

  return { ok: true as const, expiresAt, count };
}

export async function saveInquiryLease(store: BoardStore, input: { readonly jobId: string; readonly attempt: number; readonly scope: string; readonly startedAt: string }) {
  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const current = inquiryLeaseFromBoard(loaded.state, input.jobId, input.attempt, input.scope);
  if (!current.ok) return current;
  if (current.count >= 16) return pipelineFailure("inquiry_lease_history_limit", input.jobId);
  const content = { type: "tool_acquisition_inquiry_lease", schemaVersion: 1, ...input,
    specVersionId: acquisitionInquirySpecId(input.jobId, input.attempt), expiresAt: new Date(Date.parse(input.startedAt) + ACQUISITION_START_LEASE_MS).toISOString() };
  return savePipelineAsset(store, { versionId: `acquisition-inquiry-lease_v1_${contentHashOf(content)}`, kind: "workflow", source: "inferred", scope: input.scope, content, issuedAt: input.startedAt });
}
