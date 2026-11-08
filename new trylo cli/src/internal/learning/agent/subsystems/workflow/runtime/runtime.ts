import type { WorkflowEvidenceWindow, WorkflowLearningRequest, WorkflowLearningResult } from "../domain/trace-contracts.js";
import { windowWorkflowHistory } from "../domain/trace-window.js";
import { learnWorkflow, workflowMatches } from "../domain/trace-learn.js";
import { parseWorkflowLearningRequest, workflowFailure } from "../domain/trace-parse.js";
import { listWorkflowVersions, readWorkflowVersion, saveWorkflowVersion, workflowFeedback } from "./archive.js";
import { inheritedWorkflowCorrection } from "./recommendation.js";

/** Standalone subsystem entry: external nomination and allowance, internal full round. */
export async function runWorkflowLearning(input: {
  readonly boardRoot: string; readonly request: unknown; readonly issuedAt: string; readonly signal?: AbortSignal;
}): Promise<WorkflowLearningResult<{ readonly versionId: string; readonly mode: "path" | "lessons_only"; readonly traceCount: number; readonly providerCalls: 0; readonly evidenceWindow?: WorkflowEvidenceWindow }>> {
  const parsed = parseWorkflowLearningRequest(input.request);
  if (!parsed.ok) return parsed;

  if (!parsed.value.collect) return workflowFailure("collection_disabled", "no Board reads or writes when collection is disabled");

  if (input.signal?.aborted) return workflowFailure("cancelled", "learning nomination cancelled");

  let request: WorkflowLearningRequest = parsed.value;
  const source = request.correction === undefined ? "inferred" : "user_explicit";

  if (request.correction !== undefined && request.correction.when === undefined) {
    request = { ...request, correction: { ...request.correction, when: request.conditions ?? {} } };
  }

  if (request.parentVersionId !== undefined) {
    // Corrections inherit the parent's scope and evidence history before learning.
    const parent = await readWorkflowVersion(input.boardRoot, request.parentVersionId);
    if (!parent.ok) return parent;

    if (!workflowMatches(parent.value, request)) return workflowFailure("parent_mismatch", "correction scope must match the parent task family");

    let inherited = parent.value.correction;
    if (request.correction === undefined && inherited !== undefined && inherited.when === undefined) {
      const versions = await listWorkflowVersions(input.boardRoot);
      if (!versions.ok) return versions;
      inherited = inheritedWorkflowCorrection(versions.value, request.parentVersionId);
      if (inherited === undefined) return workflowFailure("invalid_correction", "correction origin is not available in immutable workflow history");
    }

    const feedback = await workflowFeedback(input.boardRoot, request.parentVersionId);
    if (!feedback.ok) return feedback;

    const windowed = windowWorkflowHistory({ request: { ...request,
      ...(request.correction !== undefined || inherited === undefined ? {} : { correction: inherited }) },
      history: [...parent.value.traces, ...feedback.value], parentVersionId: request.parentVersionId,
      supportedTraceIds: parent.value.positiveEvidenceRefs });
    if (!windowed.ok) return windowed;

    request = windowed.value;
  }

  // Derive the candidate first; cancellation still prevents its archive write.
  const learned = learnWorkflow(request);
  if (!learned.ok) return learned;

  if (input.signal?.aborted) return workflowFailure("cancelled", "learning nomination cancelled before commit");

  const saved = await saveWorkflowVersion(input.boardRoot, learned.value, input.issuedAt, source);

  return saved.ok ? { ok: true, value: { versionId: saved.value.versionId, mode: learned.value.mode, traceCount: request.traces.length, providerCalls: 0,
    ...(learned.value.evidenceWindow === undefined ? {} : { evidenceWindow: learned.value.evidenceWindow }) } } : saved;
}
