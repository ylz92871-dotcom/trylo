import type { WorkflowCheckProvenance, WorkflowCorrection, WorkflowTrace } from "./trace-contracts.js";

/** Explicit changes authorize a working check recipe; they never attest that it ran. */
export function workflowCheckProvenance(input: {
  readonly correction: WorkflowCorrection;
  readonly requestId: string;
  readonly baseEvidenceRefs: readonly string[];
  readonly traces: readonly WorkflowTrace[];
}): WorkflowCheckProvenance {
  const { correction } = input;
  const observations = input.traces.filter(trace => trace.source === "runtime" && trace.steps.some(step =>
    step.nodeId === correction.nodeId && step.check === correction.check && step.evidenceRefs.length > 0));
  const passed = observations.filter(trace => trace.steps.some(step => step.nodeId === correction.nodeId && step.check === correction.check && step.status === "passed"));

  return { nodeId: correction.nodeId, check: correction.check, sourceRef: `correction:${input.requestId}`,
    status: observations.length === 0 ? "pending_execution" : "observed", baseEvidenceRefs: input.baseEvidenceRefs,
    observedTraceIds: observations.map(trace => trace.traceId), passedTraceIds: passed.map(trace => trace.traceId) };
}

export function renderCheckProvenance(value: WorkflowCheckProvenance): string {
  const result = value.status === "pending_execution" ? "No actual execution evidence yet; prior successes do not validate this changed check."
    : value.passedTraceIds.length === 0 ? "The changed check was executed, with no passed observation yet."
      : `Actual passed observations: ${value.passedTraceIds.join(", ")}.`;
  return `Explicit check change at ${value.nodeId}: ${value.check}; source ${value.sourceRef}. ${result}`;
}
