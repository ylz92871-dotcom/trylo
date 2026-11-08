import type { WorkflowPathStatistics, WorkflowTrace } from "./trace-contracts.js";

export function traceHasFailure(trace: WorkflowTrace): boolean {
  return trace.outcome === "failure" || trace.steps.some(step => step.status === "failed") || (trace.otherFailures?.length ?? 0) > 0;
}

/** Resumed runs emit immutable cumulative snapshots, not independent trials. */
export function effectiveWorkflowTraces(traces: readonly WorkflowTrace[]): readonly WorkflowTrace[] {
  const selected = new Map<string, WorkflowTrace>();

  for (const trace of traces) {
    const key = trace.source === "runtime" && (trace.executionId !== undefined || trace.sessionId !== undefined)
      ? JSON.stringify([trace.executionId ?? trace.sessionId, trace.workflowVersionId ?? ""]) : `trace:${trace.traceId}`;
    const previous = selected.get(key);
    if (previous === undefined || trace.steps.length >= previous.steps.length) selected.set(key, trace);
  }

  const kept = new Set([...selected.values()].map(trace => trace.traceId));

  return traces.filter(trace => kept.has(trace.traceId));
}

/** Rework and failures are projections of facts, never model-maintained counters. */
export function traceStatistics(trace: WorkflowTrace) {
  const seen = new Set<string>();
  const failurePositions: number[] = [];
  let reworkSteps = 0;

  trace.steps.forEach((step, index) => {
    if (seen.has(step.nodeId)) reworkSteps += 1;
    seen.add(step.nodeId);
    if (step.status === "failed") failurePositions.push(index);
  });

  return { reworkSteps, failurePositions, totalSteps: trace.steps.length, failedOperations: trace.otherFailures?.length ?? 0 };
}

export function workflowStatistics(traces: readonly WorkflowTrace[]): WorkflowPathStatistics {
  const effective = effectiveWorkflowTraces(traces);
  const projected = effective.map(traceStatistics);

  return {
    samples: effective.length,
    successes: effective.filter(trace => trace.outcome === "success").length,
    failures: effective.filter(trace => trace.outcome === "failure").length,
    unknown: effective.filter(trace => trace.outcome === "unknown").length,
    failedChecks: projected.reduce((sum, value) => sum + value.failurePositions.length, 0),
    failedOperations: projected.reduce((sum, value) => sum + value.failedOperations, 0),
    reworkSteps: projected.reduce((sum, value) => sum + value.reworkSteps, 0),
    totalSteps: projected.reduce((sum, value) => sum + value.totalSteps, 0),
    measuredCostSamples: effective.filter(trace => trace.cost !== undefined && trace.budgetReceipt?.usageUncertain !== true).length,
    totalTokens: effective.reduce((sum, trace) => sum + (trace.cost?.tokens ?? 0), 0),
    totalWallMs: effective.reduce((sum, trace) => sum + (trace.cost?.wallMs ?? 0), 0),
  };
}

/** Compare observed use, not a generated quality verdict. Unknown cost is never zero cost. */
export function compareWorkflowUse(left: WorkflowPathStatistics, right: WorkflowPathStatistics): number {
  if (left.samples === 0 || right.samples === 0) return left.samples === right.samples ? 0 : left.samples === 0 ? 1 : -1;

  const failure = left.failures / Math.max(1, left.successes + left.failures)
    - right.failures / Math.max(1, right.successes + right.failures);
  if (failure !== 0) return failure;

  const rework = left.reworkSteps / Math.max(1, left.successes) - right.reworkSteps / Math.max(1, right.successes);
  if (rework !== 0) return rework;

  if (left.measuredCostSamples === left.samples && right.measuredCostSamples === right.samples) {
    // Include unsuccessful spend per completed task. A cancelled cheap partial
    // run must not make an expensive path appear cheaper by lowering an average.
    const tokens = left.totalTokens / Math.max(1, left.successes) - right.totalTokens / Math.max(1, right.successes);
    if (tokens !== 0) return tokens;
    const wall = left.totalWallMs / Math.max(1, left.successes) - right.totalWallMs / Math.max(1, right.successes);
    if (wall !== 0) return wall;
  }

  return left.totalSteps / Math.max(1, left.successes) - right.totalSteps / Math.max(1, right.successes);
}
