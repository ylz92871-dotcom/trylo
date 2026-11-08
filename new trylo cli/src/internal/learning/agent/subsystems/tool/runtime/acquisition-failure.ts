import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { decodeToolAcquisitionFailure, safeToolAcquisitionDiagnostics, safeToolAcquisitionFailureCode, toolAcquisitionFailureVersion,
  type ToolAcquisitionFailurePhase } from "../domain/evolution/acquisition-failure.js";
import { toolAcquisitionFromBoard } from "./acquisition-continuation.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";

/** Record only a returned host observation. Unknown process death is never manufactured into failure. */
export async function recordToolAcquisitionFailure(input: { readonly boardRoot: string; readonly jobId: string; readonly scope: string;
  readonly approvalId: string; readonly phase: ToolAcquisitionFailurePhase; readonly failure: { readonly code?: unknown; readonly diagnostics?: unknown };
  readonly issuedAt: string }) {
  const written = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const request = toolAcquisitionFromBoard(loaded.state, input.jobId, input.scope);
    if (!request.ok) return request;

    if (request.approvalId !== input.approvalId || request.decision.candidate.platform !== "npm") return pipelineFailure("acquisition_failure_binding_mismatch", input.jobId);

    const failure = decodeToolAcquisitionFailure({ type: "tool_acquisition_failure", schemaVersion: 1, jobId: input.jobId, attempt: request.attempt,
      decisionVersionId: request.approvalId, scope: input.scope, capability: request.capability, candidate: request.decision.candidate,
      phase: input.phase, code: safeToolAcquisitionFailureCode(input.failure.code), diagnostics: safeToolAcquisitionDiagnostics(input.failure.diagnostics),
      ...(request.installation === undefined ? {} : { installationId: npmInstallId(request.installation) }) });
    if (failure === undefined) return pipelineFailure("invalid_acquisition_failure", "The safe observation exceeded its canonical bounds");

    return savePipelineAsset(store, { versionId: toolAcquisitionFailureVersion(failure), kind: "workflow", source: "inferred", scope: input.scope,
      issuedAt: input.issuedAt, content: failure, observations: [request.approvalId] });
  });
  return "reason" in written ? pipelineFailure(written.reason, written.detail) : written;
}
