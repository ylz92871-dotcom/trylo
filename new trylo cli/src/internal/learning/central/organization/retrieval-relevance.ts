import { centralTextRelevance } from "../text-relevance.js";
import type { OrganizationContext, OrganizationKnowledge } from "./contracts.js";

/** Evaluate each bounded source field so a long statement cannot crowd its
 * exceptions or the original decision's residual question out of navigation. */
export function organizationPurposeRelevance(purpose: string, knowledge: OrganizationKnowledge,
  contexts: readonly OrganizationContext[]): number {
  const fields = [knowledge.statement, knowledge.conditions, knowledge.exceptions, knowledge.implication,
    ...contexts.flatMap(context => [context.purpose, ...context.known, ...context.residual])];
  let maximum = 0, total = 0;

  for (const field of fields) {
    const score = centralTextRelevance(purpose, field);
    maximum = Math.max(maximum, score);
    total += score;
  }

  return maximum + total / (fields.length * 10);
}
