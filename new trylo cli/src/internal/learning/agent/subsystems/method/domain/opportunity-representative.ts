import type { MethodExperienceFact } from "./experience-facts.js";
import { canonicalCardJson } from "./contracts.js";

type Opportunity = {
  readonly versionId: string; readonly taskId: string; readonly opportunityId: string;
  readonly compilationId?: string;
  readonly features?: Readonly<Record<string, string>>;
};

type Adoption = Extract<MethodExperienceFact, { kind: "decision" }>;

/** Shared representative policy for writing observations and reporting missing
 * feedback. Filtering by a narrower scope happens after this commitment. */
export function representativeAdoptionsOf(facts: readonly MethodExperienceFact[], beforeSequence: number): readonly Adoption[] {
  const first = new Map<string, Adoption>();

  for (const fact of facts) {
    if (fact.kind !== "decision" || fact.decision.action !== "adopt" || fact.sequence >= beforeSequence) continue;
    const key = JSON.stringify([fact.versionId, fact.context.taskId, fact.decision.compilationId]);
    const previous = first.get(key);
    if (previous === undefined || previous.sequence > fact.sequence) first.set(key, fact);
  }

  return [...first.values()];
}

/** The first adoption commits a dependent-origin representative before its
 * feedback is known. Missing feedback cannot transfer this place to a success
 * reported by a later opportunity. Scope filtering cannot reopen that choice. */
export function isRepresentativeOpportunity(facts: readonly MethodExperienceFact[], opportunity: Opportunity,
  beforeSequence: number): boolean {
  return representativeAdoptionsOf(facts, beforeSequence).some(fact => fact.versionId === opportunity.versionId &&
    fact.context.taskId === opportunity.taskId && fact.decision.compilationId === opportunity.compilationId &&
    fact.context.opportunityId === opportunity.opportunityId && (opportunity.features === undefined ||
      canonicalCardJson(fact.context.features) === canonicalCardJson(opportunity.features)));
}
