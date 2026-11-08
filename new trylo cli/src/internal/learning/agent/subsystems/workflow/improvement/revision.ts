import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovement, WorkflowProcedureStep, WorkflowProcessChange } from "./contracts.js";

function control(step: WorkflowProcedureStep): string {
  return JSON.stringify({ action: step.action, inputs: step.inputs, outputs: step.outputs,
    dependsOn: step.dependsOn, when: step.when, verify: step.verify, onFailure: step.onFailure });
}

/** Explanations cannot stand in for edits: each declared operation must affect its named controls.
 * Initial proposals have no historical program to diff and remain explicitly unproven. */
export function validateDeclaredProcessChanges(artifact: WorkflowImprovement, parent: WorkflowImprovement): WorkflowLearningResult<WorkflowImprovement> {
  const before = parent.proposal.procedure, after = artifact.proposal.procedure;
  const previous = new Map(before.steps.map((step, index) => [step.id, { step, index }]));
  const next = new Map(after.steps.map((step, index) => [step.id, { step, index }]));

  function changed(change: WorkflowProcessChange): boolean {
    if (change.kind === "stop_rule") return JSON.stringify(before.stopRules) !== JSON.stringify(after.stopRules)
      || change.stepIds.some(id => previous.get(id)?.step.onFailure.action !== next.get(id)?.step.onFailure.action);
    return change.stepIds.every(id => {
      const old = previous.get(id), current = next.get(id);

      if (change.kind === "insert") return old === undefined && current !== undefined;

      if (change.kind === "remove") return old !== undefined && current === undefined;

      if (old === undefined || current === undefined) return false;

      if (change.kind === "reorder") return old.index !== current.index
        || JSON.stringify(old.step.dependsOn) !== JSON.stringify(current.step.dependsOn);

      if (change.kind === "branch") return JSON.stringify(old.step.when) !== JSON.stringify(current.step.when)
        || JSON.stringify(old.step.onFailure) !== JSON.stringify(current.step.onFailure);

      return control(old.step) !== control(current.step)
        || change.kind === "reuse" && (JSON.stringify(before.invalidationSignals) !== JSON.stringify(after.invalidationSignals)
          || JSON.stringify(before.requiredConditions) !== JSON.stringify(after.requiredConditions));
    });
  }

  return artifact.proposal.changes.every(changed) ? { ok: true, value: artifact }
    : workflowFailure("improvement_change_unbound", "a declared process edit does not change its named steps or control rule");
}
