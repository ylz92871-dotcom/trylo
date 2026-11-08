import { shortId } from "../../../../domains/shared/hash.js";
import type { LearnedWorkflowNode, WorkflowLearningRequest, WorkflowLearningResult, WorkflowLesson, WorkflowTrace } from "./trace-contracts.js";

export function nodesFromTrace(trace: WorkflowTrace): readonly LearnedWorkflowNode[] {
  const byNode = new Map(trace.steps.filter(step => step.status === "passed").map(step => [step.nodeId, step]));
  return [...byNode.values()].map(step => ({ id: step.nodeId, input: step.input, output: step.output, dependsOn: step.dependsOn, check: step.check }));
}

export function workflowPathKey(nodes: readonly LearnedWorkflowNode[]): string {
  return shortId("path", [JSON.stringify(nodes.map(node => [node.id, [...node.dependsOn].sort(), node.check]))]);
}

export function traceFitsPath(trace: WorkflowTrace, nodes: readonly LearnedWorkflowNode[]): boolean {
  if (trace.outcome === "success" && workflowPathKey(nodesFromTrace(trace)) !== workflowPathKey(nodes)) return false;
  return trace.steps.every(step => nodes.some(node => node.id === step.nodeId && node.check === step.check
    && JSON.stringify([...node.dependsOn].sort()) === JSON.stringify([...step.dependsOn].sort())));
}

export function lessonsFromTraces(traces: readonly WorkflowTrace[]): readonly WorkflowLesson[] {
  return traces.flatMap(trace => [...trace.steps.filter(step => step.status === "failed").map(step => ({
    afterNode: step.nodeId, ...(step.recoveryTo === undefined ? {} : { goto: step.recoveryTo }),
    lesson: `Check failed at ${step.nodeId}: ${step.check}. Recheck its inputs before continuing.`,
    evidenceRefs: [trace.traceId, ...step.evidenceRefs],
  })), ...(trace.otherFailures ?? []).map(failure => ({ afterNode: `other:${failure.toolCallId}`,
    lesson: "A non-check shell operation failed. Inspect its recorded result and affected inputs before continuing; no successful path follows from this operation.",
    evidenceRefs: [trace.traceId, failure.evidenceRef] }))]);
}

export function correctWorkflowPath(
  request: WorkflowLearningRequest,
  nodes: readonly LearnedWorkflowNode[],
  recovery: readonly WorkflowLesson[],
): WorkflowLearningResult<{ readonly nodes: readonly LearnedWorkflowNode[]; readonly recovery: readonly WorkflowLesson[] }> {
  const correction = request.correction;
  if (correction === undefined) return { ok: true, value: { nodes, recovery } };

  const node = nodes.find(item => item.id === correction.nodeId);
  if (request.parentVersionId === undefined || node === undefined
    || (correction.recoveryTo !== undefined && !nodes.some(item => item.id === correction.recoveryTo))) {
    return { ok: false, code: "invalid_correction", message: "a correction requires a parent and nodes in this task-family path" };
  }

  return { ok: true, value: {
    nodes: nodes.map(item => item.id === node.id ? { ...item, check: correction.check } : item),
    recovery: [{ afterNode: node.id, ...(correction.recoveryTo === undefined ? {} : { goto: correction.recoveryTo }),
      lesson: correction.reason, evidenceRefs: [`correction:${request.requestId}`] }, ...recovery],
  } };
}
