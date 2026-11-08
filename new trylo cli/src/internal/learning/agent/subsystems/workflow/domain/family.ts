import type { TaskFamily } from "../../../../domains/shared/types.js";
import type { WorkflowTask } from "./trace-contracts.js";

/** Missing premises are not wildcards. Field order is canonical for persisted coordinates. */
export function workflowFamilyKey(family: TaskFamily): string {
  return JSON.stringify([
    family.id,
    family.intentClass,
    family.checkKind,
    family.language ?? null,
    family.repoKind ?? null,
    family.checkSchema ?? null,
  ]);
}

export function workflowMatches(left: WorkflowTask, right: WorkflowTask): boolean {
  return left.scope === right.scope && workflowFamilyKey(left.taskFamily) === workflowFamilyKey(right.taskFamily);
}

export function workflowConditionKey(conditions: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify(Object.entries(conditions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
