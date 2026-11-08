import { contentHashOf } from "../../../../control/hash.js";
import type { WorkflowLearningArtifact, WorkflowTrace } from "../domain/trace-contracts.js";
import type { WorkflowObservedTurn, WorkflowTraceProposal } from "./model-port.js";
import { bindWorkflowProposal } from "./raw-facts.js";

/** Rebind a saved interpretation to today's exact receipt snapshot, without a model. */
function matchesObservation(trace: WorkflowTrace, observed: WorkflowObservedTurn): boolean {
  if (trace.sessionId !== observed.sessionId || trace.traceId !== `observed:${observed.sessionId}:${observed.turnId}`) return false;

  const used = new Set<string>(), steps: WorkflowTraceProposal["steps"][number][] = [];

  for (const step of trace.steps) {
    const check = observed.checks.find(item => step.evidenceRefs.length === 1 && step.evidenceRefs[0] === item.evidenceRef);
    if (check === undefined || used.has(check.toolCallId)) return false;
    used.add(check.toolCallId);
    steps.push({ nodeId: step.nodeId, input: step.input, output: step.output, dependsOn: step.dependsOn,
      checkToolCallId: check.toolCallId, ...(step.recoveryTo === undefined ? {} : { recoveryTo: step.recoveryTo }) });
  }

  const rebound = bindWorkflowProposal(trace, observed, { steps, excludedCalls: observed.checks
    .filter(item => !used.has(item.toolCallId)).map(item => ({ toolCallId: item.toolCallId, role: "work", reason: "saved interpretation" })) });

  return rebound.ok && contentHashOf(rebound.value) === contentHashOf(trace);
}

/** Also covers a crash after the learned asset commits but before its job settles. */
export function workflowVersionForObservation(versions: readonly { readonly versionId: string; readonly artifact: WorkflowLearningArtifact }[],
  scope: string, observed: WorkflowObservedTurn): string | undefined {
  return [...versions].reverse().find(version => version.artifact.scope === scope
    && version.artifact.traces.some(trace => matchesObservation(trace, observed)))?.versionId;
}
