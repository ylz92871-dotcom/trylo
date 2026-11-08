import type { WorkflowLearningRequest, WorkflowLearningResult, WorkflowTrace } from "./trace-contracts.js";
import { workflowConditionKey } from "./family.js";
import { effectiveWorkflowTraces, traceHasFailure } from "./trace-statistics.js";
import { isDeepStrictEqual } from "node:util";
import { nodesFromTrace, workflowPathKey } from "./trace-paths.js";

export function workflowBudgetUsage(request: WorkflowLearningRequest) {
  return { episodes: request.traces.length, steps: request.traces.reduce((sum, trace) => sum + trace.steps.length, 0),
    estimatedTokens: Math.ceil(JSON.stringify(request).length / 4) };
}

export function workflowBudgetFits(request: WorkflowLearningRequest): boolean {
  const usage = workflowBudgetUsage(request);
  return usage.episodes <= request.budget.maxEpisodes && usage.steps <= request.budget.maxSteps && usage.estimatedTokens <= request.budget.maxTokens;
}

/** Select this round's evidence, preserving new nominations and every known
 * condition's successful support plus most recent failure. Older facts remain
 * immutable in the parent Board lineage; omissions are explicit references.
 */
export function windowWorkflowHistory(input: {
  readonly request: WorkflowLearningRequest;
  readonly history: readonly WorkflowTrace[];
  readonly parentVersionId: string;
  readonly supportedTraceIds?: readonly string[];
}): WorkflowLearningResult<WorkflowLearningRequest> {
  const { request, parentVersionId } = input;

  if (new Set(request.traces.map(trace => trace.traceId)).size !== request.traces.length) {
    return { ok: false, code: "invalid_evidence", message: "explicit traces must have unique identities" };
  }

  const source = [...new Map([...input.history, ...request.traces].map(trace => [trace.traceId, trace])).values()];
  const byId = new Map(source.map(trace => [trace.traceId, trace]));

  for (const trace of [...input.history, ...request.traces]) {
    if (!isDeepStrictEqual(byId.get(trace.traceId), trace)) return { ok: false, code: "evidence_conflict", message: trace.traceId };
  }

  const mandatory = new Set(request.traces.map(trace => trace.traceId));
  const supported = new Set(input.supportedTraceIds ?? []);
  const supportedPaths = new Set(input.history.filter(trace => supported.has(trace.traceId))
    .map(trace => workflowPathKey(nodesFromTrace(trace))));
  const groups = new Map<string, WorkflowTrace[]>();

  for (const trace of effectiveWorkflowTraces(source)) {
    const key = workflowConditionKey(trace.conditions);
    groups.set(key, [...(groups.get(key) ?? []), trace]);
  }

  for (const traces of groups.values()) {
    const latest = [...traces].reverse();
    const success = latest.find(trace => trace.outcome === "success" && supportedPaths.has(workflowPathKey(nodesFromTrace(trace))))
      ?? latest.find(trace => trace.outcome === "success");
    const failure = [...traces].reverse().find(traceHasFailure);
    if (success !== undefined) mandatory.add(success.traceId);
    if (failure !== undefined) mandatory.add(failure.traceId);
  }

  const selected = new Set(mandatory);

  function build(): WorkflowLearningRequest {
    const retained = source.filter(trace => selected.has(trace.traceId));
    return { ...request, parentVersionId, traces: retained, evidenceWindow: {
      parentVersionId, statisticsScope: "window", retainedTraceIds: retained.map(trace => trace.traceId),
      omittedRefs: source.filter(trace => !selected.has(trace.traceId)).map(trace => JSON.stringify([parentVersionId, trace.traceId])),
    } };
  }

  if (!workflowBudgetFits(build())) {
    const needed = workflowBudgetUsage(build());
    return { ok: false, code: "waiting_evidence_budget", message: `preserving explicit traces and every condition needs at least ${needed.episodes} episodes, ${needed.steps} steps and ${needed.estimatedTokens} estimated tokens; no branch was discarded` };
  }

  let optionalAttempts = 0;

  for (const trace of [...source].reverse()) {
    if (selected.has(trace.traceId)) continue;
    if (selected.size >= request.budget.maxEpisodes || optionalAttempts >= request.budget.maxEpisodes) break;
    optionalAttempts += 1;
    selected.add(trace.traceId);
    if (!workflowBudgetFits(build())) selected.delete(trace.traceId);
  }

  return { ok: true, value: build() };
}
