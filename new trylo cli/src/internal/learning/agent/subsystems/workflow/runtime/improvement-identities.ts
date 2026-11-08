import { contentHashOf } from "../../../../control/hash.js";

export function workflowImprovementRecordId<T extends { readonly type: string }>(content: T): string {
  return `wfi:${content.type}:${contentHashOf(content)}`;
}

/** The suffix binds any explicitly issued run grant to one immutable opportunity input. */
export function workflowImprovementGrantSuffix(inputVersionId: string): string {
  return `:${contentHashOf(inputVersionId).slice(0, 32)}`;
}

/** Shared canonical source receipt for preparation and exact central dispatch. */
export function workflowImprovementSourceBindingRef(centralScope: string, inputVersionId: string): string {
  return `workflow-input:${contentHashOf([centralScope, inputVersionId])}`;
}
