import type { WorkflowLearningArtifact, WorkflowLearningRequest, WorkflowLearningResult, WorkflowLesson } from "./trace-contracts.js";
import { workflowMatches } from "./family.js";

/** Bounded, deterministic first learner: no provider/tool calls and no global scan. */
export function learnWorkflowV1(request: WorkflowLearningRequest): WorkflowLearningResult<WorkflowLearningArtifact> {
  if (!request.collect) return { ok: false, code: "collection_disabled", message: "collection is disabled; nothing was read or saved" };

  const traces = request.traces;
  const estimatedTokens = Math.ceil(JSON.stringify(request).length / 4);
  if (traces.length > request.budget.maxEpisodes || traces.reduce((sum, trace) => sum + trace.steps.length, 0) > request.budget.maxSteps
    || estimatedTokens > request.budget.maxTokens) return { ok: false, code: "budget_exhausted", message: "trace input exceeds this nomination's episode/step/token allowance" };

  if (traces.length === 0 || new Set(traces.map(trace => trace.traceId)).size !== traces.length) {
    return { ok: false, code: "invalid_evidence", message: "at least one uniquely identified trace is required" };
  }

  if (traces.some(trace => !workflowMatches(trace, request))) return { ok: false, code: "task_family_mismatch", message: "scope and every task-family premise must match; partition unrelated traces before learning" };

  // The most recent successful experience is a candidate path, not a quality verdict.
  const successful = traces.filter(trace => trace.outcome === "success");
  const exemplar = successful.at(-1);
  const byNode = new Map(exemplar?.steps.filter(step => step.status === "passed").map(step => [step.nodeId, step]));
  const nodes = [...byNode.values()].map(step => ({ id: step.nodeId, input: step.input, output: step.output, dependsOn: step.dependsOn, check: step.check }));
  const recovery: WorkflowLesson[] = traces.flatMap(trace => trace.steps.filter(step => step.status === "failed").map(step => ({
    afterNode: step.nodeId, ...(step.recoveryTo === undefined ? {} : { goto: step.recoveryTo }),
    lesson: `Check failed at ${step.nodeId}: ${step.check}. Recheck its inputs before continuing.`,
    evidenceRefs: [trace.traceId, ...step.evidenceRefs],
  })));
  const correction = request.correction;
  if (correction !== undefined) {
    const node = nodes.find(item => item.id === correction.nodeId);
    if (request.parentVersionId === undefined || node === undefined || (correction.recoveryTo !== undefined && !nodes.some(item => item.id === correction.recoveryTo))) {
      return { ok: false, code: "invalid_correction", message: "a correction requires a parent and nodes in this task-family path" };
    }

    nodes[nodes.indexOf(node)] = { ...node, check: correction.check };
    recovery.unshift({ afterNode: node.id, ...(correction.recoveryTo === undefined ? {} : { goto: correction.recoveryTo }),
      lesson: correction.reason, evidenceRefs: [`correction:${request.requestId}`] });
  }

  // Dangling fallback targets remain failure lessons, never runnable recovery edges.
  const boundedRecovery = recovery.map(lesson => lesson.goto === undefined || nodes.some(node => node.id === lesson.goto)
    ? lesson : { afterNode: lesson.afterNode, lesson: `${lesson.lesson} Unresolved recovery target: ${lesson.goto}.`, evidenceRefs: lesson.evidenceRefs });

  return { ok: true, value: { schemaVersion: 1, type: "workflow_learning", requestId: request.requestId,
    scope: request.scope, taskFamily: request.taskFamily, mode: nodes.length === 0 ? "lessons_only" : "path", nodes,
    recovery: boundedRecovery, traces,
    positiveEvidenceRefs: exemplar === undefined ? [] : [exemplar.traceId],
    negativeEvidenceRefs: traces.filter(trace => trace.outcome === "failure" || trace.steps.some(step => step.status === "failed")).map(trace => trace.traceId),
    ...(request.parentVersionId === undefined ? {} : { parentVersionId: request.parentVersionId }),
    ...(correction === undefined ? {} : { correction }) } };
}

