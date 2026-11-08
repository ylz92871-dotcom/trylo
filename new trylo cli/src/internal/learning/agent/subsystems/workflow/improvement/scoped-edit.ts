import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { record, text, workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovement, WorkflowImprovementProposal, WorkflowProcedureStep } from "./contracts.js";
import { parseWorkflowImprovementProposal } from "./parse.js";
import { isDeepStrictEqual } from "node:util";

/** Include direct data/recovery neighbors so a rewrite can inspect the controls it reconnects. */
export function workflowImprovementEditScope(parent: WorkflowImprovement | undefined,
  affectedStepIds: readonly string[]): WorkflowLearningResult<readonly WorkflowProcedureStep[]> {
  if (parent === undefined) return workflowFailure("improvement_edit_parent_required", "local rewriting needs an existing process parent");

  const steps = parent.proposal.procedure.steps, ids = new Set(affectedStepIds);
  if (ids.size === 0 || ids.size > 8 || ids.size !== affectedStepIds.length || affectedStepIds.some(id => !steps.some(step => step.id === id))) {
    return workflowFailure("improvement_edit_target_invalid", "name at most eight distinct steps from the current improvement parent");
  }

  return { ok: true, value: steps.filter(step => ids.has(step.id) || step.dependsOn.some(id => ids.has(id))
    || step.onFailure.action === "goto" && ids.has(step.onFailure.target)
    || steps.some(target => ids.has(target.id) && (target.dependsOn.includes(step.id)
      || target.onFailure.action === "goto" && target.onFailure.target === step.id))) };
}

/** Untouched steps are copied from the immutable parent rather than re-emitted by the model. */
export function validateWorkflowScopedRevision(candidate: WorkflowImprovementProposal, parent: WorkflowImprovement,
  affectedStepIds: readonly string[]): WorkflowLearningResult<WorkflowImprovementProposal> {
  const scope = workflowImprovementEditScope(parent, affectedStepIds);
  if (!scope.ok) return scope;

  const editable = new Set(scope.value.map(step => step.id)), removable = new Set(affectedStepIds);
  const before = parent.proposal.procedure.steps, after = candidate.procedure.steps;
  const previous = new Map(before.map(step => [step.id, step]));
  const exposed = new Set([...editable, ...after.filter(step => !previous.has(step.id)).map(step => step.id)]);

  for (const step of before) {
    const current = after.find(item => item.id === step.id);
    if (current === undefined && !removable.has(step.id)) return workflowFailure("improvement_edit_outside_scope", "only nominated steps can be removed");
    if (!editable.has(step.id) && !isDeepStrictEqual(step, current)) {
      return workflowFailure("improvement_edit_outside_scope", "a local rewrite cannot alter unexposed steps");
    }
  }

  for (const step of after) {
    if (previous.has(step.id) && !editable.has(step.id)) continue;

    const old = previous.get(step.id), oldRecovery = old?.onFailure;
    const newDependencies = step.dependsOn.filter(id => !old?.dependsOn.includes(id));
    const newRecovery = step.onFailure.action === "goto"
      && (oldRecovery?.action !== "goto" || oldRecovery.target !== step.onFailure.target)
      ? [step.onFailure.target] : [];
    if ([...newDependencies, ...newRecovery].some(id => !exposed.has(id))) {
      return workflowFailure("improvement_edit_unexposed_edge", "a local rewrite cannot add data or recovery edges to unexposed parent steps; nominate their context or use a full rewrite");
    }
  }

  const outside = (steps: readonly WorkflowProcedureStep[]) => steps.filter(step => before.some(old => old.id === step.id) && !editable.has(step.id)).map(step => step.id);
  if (JSON.stringify(outside(before)) !== JSON.stringify(outside(after))) return workflowFailure("improvement_edit_outside_scope", "unrelated steps retain their relative order");

  return { ok: true, value: candidate };
}

function editFailure(message: string) { return workflowFailure("invalid_workflow_process_patch", message); }

/** A deliberately small wire language for process edits, not executable code or another asset type. */
export function applyWorkflowImprovementPatch(value: unknown, parent: WorkflowImprovement,
  affectedStepIds: readonly string[]): WorkflowLearningResult<WorkflowImprovementProposal> {
  const scope = workflowImprovementEditScope(parent, affectedStepIds);
  if (!scope.ok) return scope;

  if (!record(value) || !record(value.procedurePatch) || !Array.isArray(value.procedurePatch.operations)
    || value.procedurePatch.operations.length === 0 || value.procedurePatch.operations.length > 16) return editFailure("a bounded list of actual process edits is required");

  const patch = value.procedurePatch, steps: unknown[] = [...parent.proposal.procedure.steps];
  const idOf = (step: unknown) => record(step) && text(step.id) ? step.id : undefined;
  const indexOf = (id: string) => steps.findIndex(step => idOf(step) === id);

  for (const operation of value.procedurePatch.operations) {
    if (!record(operation)) return editFailure("invalid process edit");
    if (operation.op === "remove" && text(operation.stepId)) {
      const index = indexOf(operation.stepId);
      if (index < 0) return editFailure("removed step is absent");
      steps.splice(index, 1);
    } else if (operation.op === "replace" && record(operation.step) && text(operation.step.id)) {
      const index = indexOf(operation.step.id);
      if (index < 0) return editFailure("replacement must retain an existing step identity");
      steps[index] = operation.step;
    } else if (operation.op === "insert" && record(operation.step) && text(operation.step.id)) {
      if (indexOf(operation.step.id) >= 0 || steps.length >= 32) return editFailure("inserted step needs a fresh identity within the step limit");
      const index = operation.before === undefined ? steps.length : text(operation.before) ? indexOf(operation.before) : -1;
      if (index < 0) return editFailure("insertion anchor is absent");
      steps.splice(index, 0, operation.step);
    } else if (operation.op === "reorder" && Array.isArray(operation.stepIds) && operation.stepIds.every(text)) {
      if (operation.stepIds.length !== steps.length || new Set(operation.stepIds).size !== steps.length
        || operation.stepIds.some(id => indexOf(id) < 0)) return editFailure("reordering must name every resulting step exactly once");
      const ordered = operation.stepIds.map(id => steps[indexOf(id)]);
      steps.splice(0, steps.length, ...ordered);
    } else return editFailure("unknown or malformed process operation");
  }

  const controls = patch.controls === undefined ? {} : patch.controls;
  if (!record(controls) || Object.keys(controls).some(key => !["name", "requiredConditions", "assumptions", "invalidationSignals", "stopRules"].includes(key))) {
    return editFailure("local controls cannot replace quality requirements or inject authority fields");
  }

  const parsed = parseWorkflowImprovementProposal({ diagnosis: value.diagnosis, changes: value.changes,
    procedure: { ...parent.proposal.procedure, ...controls, steps } });

  return parsed.ok ? validateWorkflowScopedRevision(parsed.value, parent, affectedStepIds) : parsed;
}

export function parseWorkflowImprovementResponse(value: unknown, parent?: WorkflowImprovement,
  affectedStepIds?: readonly string[]): WorkflowLearningResult<WorkflowImprovementProposal> {
  if (record(value) && value.abstain === true) return workflowFailure("learning_abstained", "the researcher did not claim a supported process improvement within the available context");
  if (affectedStepIds === undefined) return parseWorkflowImprovementProposal(value);
  return parent === undefined ? workflowFailure("improvement_edit_parent_required", "local rewriting needs a parent")
    : applyWorkflowImprovementPatch(value, parent, affectedStepIds);
}
