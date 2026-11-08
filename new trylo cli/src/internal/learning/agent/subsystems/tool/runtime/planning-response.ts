import type { JsonValue } from "../../../../../protocol/envelope.js";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isJsonValue, keysAre, recordOf } from "../domain/evolution/parse.js";
import { isToolPlanningOutputRejection } from "../domain/evolution/managed-continuation.js";
import { resultVersionId } from "../domain/evolution/pipeline.js";
import type { ToolLearningContext } from "../domain/evolution/learning-plan.js";
import { resultForJob } from "./pipeline-records.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";

/** Preserve rejected public JSON before the worker retires its in-memory
 * response. This is untrusted output data, never an accepted decision. */
export async function retainRejectedToolPlanningResponse(input: { readonly boardRoot: string; readonly scope: string;
  readonly jobId: string; readonly attempt: number; readonly step: number; readonly occurredAt: string;
  readonly context: ToolLearningContext; readonly value: unknown }) {
  if (!isJsonValue(input.value)) return { ok: true as const, retained: false };

  const value: JsonValue = input.value;

  return withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const job = loaded.state.jobs.find(row => row.jobId === input.jobId);
    if (job?.state !== "running" || job.domain !== "tool" || job.attempt !== input.attempt || job.scope !== input.scope) return pipelineFailure("stale_job_result", input.jobId);
    return savePipelineAsset(store, { versionId: responseRef(input.jobId, input.attempt, input.step), kind: "workflow", scope: input.scope,
      source: "inferred", issuedAt: input.occurredAt, content: { type: "tool_learning_planning_response", schemaVersion: 1,
        jobId: input.jobId, attempt: input.attempt, step: input.step, contextHash: contentHashOf(input.context), value } });
  });
}

/** Only the preceding exact attempt feeds its rejection back. Legacy absence
 * stays explicit; a missing body is never reconstructed from a failure code. */
export function previousToolPlanningFailure(state: BoardState, jobId: string, attempt: number) {
  const result = resultForJob(state, jobId, attempt);
  if (result === undefined || !isToolPlanningOutputRejection(result.code)) return { ok: true as const };

  const rows = state.assets.filter(asset => recordOf(asset.content) && asset.content.type === "tool_learning_planning_response"
    && asset.content.jobId === jobId && asset.content.attempt === attempt);
  const scope = state.jobs.find(job => job.jobId === jobId)?.scope;
  let latest: { readonly ref: string; readonly step: number; readonly value: JsonValue } | undefined;

  for (const asset of rows) {
    const row = asset.content;
    if (!recordOf(row) || !keysAre(row, ["type", "schemaVersion", "jobId", "attempt", "step", "contextHash", "value"])
      || row.schemaVersion !== 1 || typeof row.step !== "number" || !Number.isSafeInteger(row.step) || row.step < 1
      || typeof row.contextHash !== "string" || !/^[a-f0-9]{64}$/.test(row.contextHash) || !isJsonValue(row.value)
      || asset.kind !== "workflow" || asset.scope !== scope || asset.versionId !== responseRef(jobId, attempt, row.step) || !assetAvailable(state, asset)) {
      return pipelineFailure("invalid_planning_response", "The original rejected response lost its canonical binding");
    }

    if (latest === undefined || row.step > latest.step) latest = { ref: asset.versionId, step: row.step, value: row.value };
  }

  const response = latest === undefined ? { state: "unavailable" as const, reason: "original_response_not_archived" as const }
    : { state: "retained" as const, ref: latest.ref, value: latest.value };

  return { ok: true as const, failure: { resultRef: resultVersionId(jobId, attempt), attempt, code: result.code, response } };
}

function responseRef(jobId: string, attempt: number, step: number): string { return `tool-planning-response:${jobId}:${attempt}:${step}`; }
